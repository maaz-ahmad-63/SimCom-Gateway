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
import { createLogger, redactDiagnosticText } from './logger.js';

export interface CallSessionManagerOptions {
  modem: IModemAdapter;
  audio?: IAudioAdapter;
  eventBus?: GatewayEventBus;
  enableUsbAudioDiagnostic?: boolean;
}

export class CallSessionManager extends EventEmitter implements ICallSessionManager {
  private readonly modem: IModemAdapter;
  private readonly audio?: IAudioAdapter;
  private readonly eventBus?: GatewayEventBus;

  private activeStateMachine: CallStateMachine | null = null;
  private dialTimeoutTimer: NodeJS.Timeout | null = null;
  private pendingTerminationReason: string | undefined;
  private readonly logger = createLogger('CallSessionManager');
  private readonly enableUsbAudioDiagnostic: boolean;
  private usbAudioDiagnosticActive = false;
  private usbAudioDiagnosticDeactivation: Promise<{
    command: string;
    response: string;
    timestamp: string;
  } | null> | null = null;

  constructor(options: CallSessionManagerOptions) {
    super();
    this.modem = options.modem;
    this.audio = options.audio;
    this.eventBus = options.eventBus;
    this.enableUsbAudioDiagnostic = options.enableUsbAudioDiagnostic ?? false;

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
    this.logger.info(`Outbound call ${sm.getSession().id} entered DIALING`);
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
      this.logger.info(`Sending outbound dial command for call ${sm.getSession().id}`);
      await this.modem.dial(request.phoneNumber);
      this.logger.info(`Dial command accepted for call ${sm.getSession().id}`);
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
    this.pendingTerminationReason = reason;

    if (currentState === 'IDLE' || currentState === 'TERMINATING') {
      return;
    }

    try {
      await this.modem.hangup();
    } catch {
      // Continue cleanup even if modem returns error on hangup
    }

    try {
      await this.deactivateUsbAudioDiagnostic();
    } catch (error) {
      this.logger.error(`USB audio diagnostic cleanup failed: ${(error as Error).message}`);
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

  async activateUsbAudioDiagnostic(): Promise<{ command: string; response: string; timestamp: string }> {
      if (!this.enableUsbAudioDiagnostic) {
        throw new Error('USB audio diagnostic is disabled');
      }
      if (!this.activeStateMachine || this.activeStateMachine.getState() !== 'ACTIVE') {
        throw new InvalidStateTransitionError(
          this.activeStateMachine?.getState() ?? 'IDLE',
          'ACTIVE',
          'USB audio diagnostic requires an active call'
        );
      }
      if (this.usbAudioDiagnosticActive) {
        throw new Error('USB audio diagnostic is already active');
      }

      const command = 'AT+CPCMREG=1';
      const timestamp = new Date().toISOString();
      const response = await this.modem.executeCommand(command);
      if (!/\bOK\b/.test(response)) {
        throw new Error(`USB audio activation rejected: ${response}`);
      }
      this.usbAudioDiagnosticActive = true;
      this.logger.info(`USB audio diagnostic activated at ${timestamp}; response metadata recorded`);
      return { command, response, timestamp };
    }

    async deactivateUsbAudioDiagnostic(): Promise<{ command: string; response: string; timestamp: string } | null> {
      if (this.usbAudioDiagnosticDeactivation) {
        return this.usbAudioDiagnosticDeactivation;
      }
      if (!this.usbAudioDiagnosticActive) {
        return null;
      }
      const command = 'AT+CPCMREG=0';
      const timestamp = new Date().toISOString();
      this.usbAudioDiagnosticDeactivation = (async () => {
        try {
          const response = await this.modem.executeCommand(command);
          if (!/\bOK\b/.test(response)) {
            throw new Error(`USB audio deactivation rejected: ${response}`);
          }
          this.logger.info(`USB audio diagnostic deactivated at ${timestamp}; response metadata recorded`);
          return { command, response, timestamp };
        } finally {
          this.usbAudioDiagnosticActive = false;
          this.usbAudioDiagnosticDeactivation = null;
        }
      })();
      return this.usbAudioDiagnosticDeactivation;
    }

  private bindModemEvents(): void {
    this.modem.on('urc', (urc: UrcEvent) => {
      this.handleUrc(urc);
    });

    this.modem.on('error', (err: Error) => {
      if (this.listenerCount('error') > 0) {
        this.emit('error', err);
      }
      this.eventBus?.emit('error', err);
    });
  }

  private handleUrc(urc: UrcEvent): void {
    this.logger.info(
      `Call URC ${urc.type} received: ${redactDiagnosticText(urc.raw)}`
    );
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

    if (
      urc.type === 'VOICE_CALL_END' ||
      urc.type === 'NO_CARRIER' ||
      urc.type === 'NO_ANSWER'
    ) {
      if (this.activeStateMachine && this.activeStateMachine.getState() !== 'IDLE') {
        this.clearDialTimer();
        void this.deactivateUsbAudioDiagnostic().catch((error: Error) => {
          this.logger.error(`USB audio diagnostic cleanup failed: ${error.message}`);
          this.eventBus?.emit('error', error);
        });
        if (this.audio) {
          this.audio.stopSession().catch(() => {});
        }
        const callEnd = urc as CallEndUrcEvent;
        const wasAnswered = Boolean(this.activeStateMachine.getSession().answeredAt);
        this.applyTransition(this.activeStateMachine, 'TERMINATING', {
          reason: this.pendingTerminationReason ?? (wasAnswered
            ? 'Remote party disconnected'
            : urc.type === 'NO_ANSWER'
              ? 'Remote party did not answer'
              : 'Call ended before answer'),
        });
        this.finalizeCall(this.activeStateMachine);
      }
      return;
    }

    if (urc.type === 'BUSY') {
      if (this.activeStateMachine && this.activeStateMachine.getState() !== 'IDLE') {
        this.clearDialTimer();
        void this.deactivateUsbAudioDiagnostic().catch((error: Error) => {
          this.logger.error(`USB audio diagnostic cleanup failed: ${error.message}`);
          this.eventBus?.emit('error', error);
        });
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
    this.logger.info(
      `Call ${sm.getSession().id} state transition ${sm.getState()} -> ${nextState}${
        options?.reason ? ` (${redactDiagnosticText(options.reason)})` : ''
      }`
    );
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
    this.pendingTerminationReason = undefined;

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
