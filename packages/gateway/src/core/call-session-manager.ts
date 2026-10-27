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
  ModemConnectionState,
  UsbAudioActivation,
  UsbAudioRecoveryReport,
  UsbAudioStatus,
  SerialPortDisconnectedError,
} from '@sim-gateway/shared';
import { AtParser } from '../adapters/modem/at-parser.js';
import { CallStateMachine } from './call-state-machine.js';
import { GatewayBusyError, InvalidStateTransitionError } from './errors.js';
import { GatewayEventBus } from './event-bus.js';
import { createLogger, redactDiagnosticText } from './logger.js';

/** A GSM ring cycle is ~5s; no RING/+CLIP for this long means the inbound session is stale. */
const INBOUND_RING_STALE_MS = 15_000;

/** Bytes that must arrive inside the window to call USB audio "flowing": ~200 ms at 16,000 bytes/s. */
const USB_AUDIO_FLOW_MIN_BYTES = 3200;
const USB_AUDIO_FLOW_WAIT_MS = 2000;
/** A stream is "stalled" when registered and streaming yet silent on the wire for this long. */
const USB_AUDIO_STALL_MS = 500;

export interface CallSessionManagerOptions {
  modem: IModemAdapter;
  audio?: IAudioAdapter;
  eventBus?: GatewayEventBus;
  enableUsbAudioDiagnostic?: boolean;
  /** How long the modem must stay READY before USB audio recovery runs. Default 3000 ms. */
  usbRecoveryStableMs?: number;
}

export class CallSessionManager extends EventEmitter implements ICallSessionManager {
  private readonly modem: IModemAdapter;
  private readonly audio?: IAudioAdapter;
  private readonly eventBus?: GatewayEventBus;

  private activeStateMachine: CallStateMachine | null = null;
  private dialTimeoutTimer: NodeJS.Timeout | null = null;
  private pendingTerminationReason: string | undefined;
  private lastInboundRingAt = 0;
  private inboundRingTimer: NodeJS.Timeout | null = null;
  private readonly logger = createLogger('CallSessionManager');
  private readonly enableUsbAudioDiagnostic: boolean;
  private usbAudioDiagnosticActive = false;
  /** Set when the modem dropped mid-call: the registration may be gone until recovery verifies it. */
  private usbAudioStale = false;
  /** The last AT+CPCMREG=0 failed: the module may still be registered although this gateway has stopped using it. */
  private usbAudioRegistrationUncertain = false;
  private lastDeactivation: { ok: boolean; at: string; error?: string } | null = null;
  private lastModuleAudioFormat: UsbAudioActivation['moduleAudioFormat'] | null = null;
  private modemLostDuringCall = false;
  private modemState: ModemConnectionState = 'DISCONNECTED';
  /** Bumped on every modem drop during a call; a recovery that started in an older epoch is void. */
  private modemEpoch = 0;
  private usbRecoveryTimer: NodeJS.Timeout | null = null;
  private readonly usbRecoveryStableMs: number;
  private lastUsbRecovery: UsbAudioRecoveryReport | null = null;
  private usbAudioRecovery: Promise<UsbAudioRecoveryReport> | null = null;
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
    this.usbRecoveryStableMs = options.usbRecoveryStableMs ?? 3000;

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
    this.applyTransition(sm, 'DIALING', { trigger: 'api:dial' });
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
        trigger: 'dial-command-failed',
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
    this.applyTransition(this.activeStateMachine, 'ACTIVE', { trigger: 'api:answer' });

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

    this.applyTransition(sm, 'TERMINATING', { reason, trigger: 'api:hangup' });
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

  /** True only while the AT+CPCMREG registration is believed valid; false after a modem drop until verified. */
  isUsbAudioDiagnosticActive(): boolean {
    return this.usbAudioDiagnosticActive && !this.usbAudioStale;
  }

  getUsbAudioStatus(): UsbAudioStatus {
    const stats = this.audio?.getStats();
    const lastFrameAt = stats?.lastFrameAt ?? null;
    const msSinceLastFrame = lastFrameAt === null ? null : Date.now() - lastFrameAt;
    const inCall = this.activeStateMachine?.getState() === 'ACTIVE';
    let state: UsbAudioStatus['audio']['state'] = 'not-expected';
    if (inCall && this.usbAudioDiagnosticActive) {
      if (this.usbAudioStale) state = 'unverified';
      else if (!stats?.isStreaming) state = 'not-streaming';
      else state = msSinceLastFrame !== null && msSinceLastFrame <= USB_AUDIO_STALL_MS ? 'flowing' : 'stalled';
    }
    return {
      registrationActive: this.isUsbAudioDiagnosticActive(),
      needsRecovery: this.usbAudioStale,
      lastRecovery: this.lastUsbRecovery,
      audio: { state, msSinceLastFrame },
      moduleAudioFormat: this.usbAudioDiagnosticActive ? this.lastModuleAudioFormat : null,
      registrationUncertain: this.usbAudioRegistrationUncertain,
      lastDeactivation: this.lastDeactivation,
    };
  }

  async activateUsbAudioDiagnostic(): Promise<UsbAudioActivation> {
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
      if (this.usbAudioDiagnosticActive && !this.usbAudioStale) {
        throw new Error('USB audio diagnostic is already active');
      }

      const command = 'AT+CPCMREG=1';
      const timestamp = new Date().toISOString();
      const response = await this.modem.executeCommand(command);
      if (!/\bOK\b/.test(response)) {
        throw new Error(`USB audio activation rejected: ${response}`);
      }
      this.usbAudioDiagnosticActive = true;
      this.usbAudioStale = false;
      this.usbAudioRegistrationUncertain = false;
      this.logger.info(`USB audio diagnostic activated at ${timestamp}; response metadata recorded`);
      const moduleAudioFormat = await this.queryModuleAudioFormat();
      this.lastModuleAudioFormat = moduleAudioFormat;
      return { command, response, timestamp, moduleAudioFormat };
    }

    /**
     * Read-only queries of what the module says it is using. Best effort: a firmware that rejects
     * either query leaves that field null, and nothing is ever changed.
     */
    private async queryModuleAudioFormat(): Promise<NonNullable<UsbAudioActivation['moduleAudioFormat']>> {
      const ask = async (command: string, prefix: string): Promise<number[] | null> => {
        try {
          return AtParser.parsePrefixedIntegers(await this.modem.executeCommand(command, 2000), prefix);
        } catch {
          return null;
        }
      };
      const frm = await ask('AT+CPCMFRM?', 'CPCMFRM');
      const bandwidth = await ask('AT+CPCMBANDWIDTH?', 'CPCMBANDWIDTH');
      return {
        cpcmfrm: frm ? frm[0] : null,
        cpcmbandwidth: bandwidth && bandwidth.length >= 2 ? { volte: bandwidth[0], novolte: bandwidth[1] } : null,
      };
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
          // Only a stop the module accepted ends the activation.
          this.usbAudioDiagnosticActive = false;
          this.usbAudioRegistrationUncertain = false;
          this.lastDeactivation = { ok: true, at: timestamp };
          this.logger.info(`USB audio diagnostic deactivated at ${timestamp}; response metadata recorded`);
          return { command, response, timestamp };
        } catch (error) {
          this.settleFailedDeactivation(error as Error, timestamp);
          throw error;
        } finally {
          this.usbAudioDiagnosticDeactivation = null;
        }
      })();
      return this.usbAudioDiagnosticDeactivation;
    }

  /**
   * AT+CPCMREG=0 was rejected or never answered, so nothing here may claim the module stopped USB audio.
   * During a call the activation stays on record but unverified (so the dashboard says 'unverified', not
   * 'not-expected'). Once there is no call, this gateway stops treating USB audio as active for the next call
   * and instead carries the doubt forward as registrationUncertain, until a later activation applies it afresh.
   */
  private settleFailedDeactivation(error: Error, at: string): void {
    this.lastDeactivation = { ok: false, at, error: redactDiagnosticText(error.message) };
    if (this.activeStateMachine?.getState() === 'ACTIVE') {
      this.usbAudioStale = true;
    } else {
      this.usbAudioDiagnosticActive = false;
      this.usbAudioRegistrationUncertain = true;
    }
    this.logger.warn(`AT+CPCMREG=0 did not succeed (${redactDiagnosticText(error.message)}); the module's USB audio state is unknown`);
    this.eventBus?.emit('gateway:alert', {
      level: 'warn',
      message: 'Stopping USB audio (AT+CPCMREG=0) failed; the module may still hold the registration',
      timestamp: new Date().toISOString(),
    });
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

    this.modem.on('connection_state', (state: ModemConnectionState) => {
      this.handleModemConnectionState(state);
    });
  }

  /**
   * A modem that leaves READY during a call may have lost the USB audio registration, the audio
   * port and even the call itself, and the URC announcing that can be lost with it. Mark everything
   * unverified at once. The modem can flap several times in a minute, so verification waits until it
   * has stayed READY for a quiet period instead of poking a half-enumerated device.
   */
  private handleModemConnectionState(state: ModemConnectionState): void {
    this.modemState = state;
    const sm = this.activeStateMachine;
    const inCall = sm !== null && sm.getState() === 'ACTIVE';

    if (state !== 'READY') {
      this.clearUsbRecoveryTimer();
      if (inCall) {
        // Every drop voids whatever recovery is already running.
        this.modemEpoch++;
        const first = !this.modemLostDuringCall;
        this.modemLostDuringCall = true;
        if (this.usbAudioDiagnosticActive) this.usbAudioStale = true;
        if (first) {
          this.logger.warn(`Modem left READY (${state}) during an active call; call and USB audio are unverified`);
          this.eventBus?.emit('gateway:alert', {
            level: 'warn',
            message: `Modem connection lost during an active call (${state}); call and USB audio state unverified`,
            timestamp: new Date().toISOString(),
          });
        }
      }
      return;
    }

    if (this.modemLostDuringCall && inCall) {
      this.scheduleUsbRecovery();
    }
  }

  private scheduleUsbRecovery(): void {
    this.clearUsbRecoveryTimer();
    this.usbRecoveryTimer = setTimeout(() => {
      this.usbRecoveryTimer = null;
      if (
        this.modemState === 'READY' &&
        this.modemLostDuringCall &&
        this.activeStateMachine?.getState() === 'ACTIVE'
      ) {
        void this.recoverUsbAudio('modem-reconnected');
      }
    }, this.usbRecoveryStableMs);
  }

  private clearUsbRecoveryTimer(): void {
    if (this.usbRecoveryTimer) {
      clearTimeout(this.usbRecoveryTimer);
      this.usbRecoveryTimer = null;
    }
  }

  /**
   * Verify, in order: is the call still alive (AT+CLCC); can the audio port be reopened (done BEFORE
   * the registration check, so the module sees a fresh handle); is the USB audio registration still
   * set (AT+CPCMREG?, re-issued only if the operator had activated it); do PCM bytes really arrive.
   * Reconnecting the AT port proves none of these, and a registration flag of 1 is not a stream: if
   * the flag is set but nothing arrives, the registration is re-applied once. Never throws, and the
   * only retry is that single re-registration; each outcome is reported as found.
   */
  async recoverUsbAudio(trigger: UsbAudioRecoveryReport['trigger'] = 'manual'): Promise<UsbAudioRecoveryReport> {
    if (this.usbAudioRecovery) return this.usbAudioRecovery;
    const epoch = this.modemEpoch;
    const run = this.runUsbAudioRecovery(trigger, epoch).finally(() => {
      this.usbAudioRecovery = null;
      // The modem dropped again while this ran, so its verdict is void: check again once it settles.
      if (
        this.modemEpoch !== epoch &&
        this.modemState === 'READY' &&
        this.activeStateMachine?.getState() === 'ACTIVE'
      ) {
        this.scheduleUsbRecovery();
      }
    });
    this.usbAudioRecovery = run;
    return run;
  }

  private async runUsbAudioRecovery(
    trigger: UsbAudioRecoveryReport['trigger'],
    epoch: number
  ): Promise<UsbAudioRecoveryReport> {
    const startedAt = new Date().toISOString();
    const sm = this.activeStateMachine;
    const report: UsbAudioRecoveryReport = {
      trigger,
      startedAt,
      finishedAt: startedAt,
      callId: sm ? sm.getSession().id : null,
      call: 'none',
      registration: 'not-applicable',
      audioPort: 'not-applicable',
      audioFlowing: null,
      notes: [],
    };
    const superseded = (): boolean => this.modemEpoch !== epoch;
    const portDropped = (error: unknown): boolean =>
      superseded() || error instanceof SerialPortDisconnectedError;

    const finish = (): UsbAudioRecoveryReport => {
      report.finishedAt = new Date().toISOString();
      this.lastUsbRecovery = report;
      const healthy =
        report.call === 'usable' &&
        report.registration !== 'failed' &&
        report.audioPort !== 'failed' &&
        report.audioFlowing !== false;
      this.logger.info(
        `USB audio recovery (${trigger}): call=${report.call} registration=${report.registration} audioPort=${report.audioPort} audioFlowing=${report.audioFlowing}`
      );
      this.eventBus?.emit('gateway:alert', {
        level: healthy ? 'info' : 'warn',
        message: `USB audio recovery: call ${report.call}, registration ${report.registration}, audio port ${report.audioPort}, audio flowing ${report.audioFlowing}`,
        timestamp: report.finishedAt,
      });
      return report;
    };
    /** The modem dropped again: this verdict would describe a device that no longer exists. */
    const abandon = (): UsbAudioRecoveryReport => {
      report.notes.push('Modem dropped again during recovery; nothing here is trusted, it will run again');
      if (this.usbAudioDiagnosticActive) this.usbAudioStale = true;
      return finish();
    };

    try {
      if (!sm || sm.getState() !== 'ACTIVE') {
        report.notes.push('No active call; nothing to recover');
        return finish();
      }

      // 1. Is the call still alive? Only a successful AT+CLCC answer is believed, in either direction.
      try {
        const calls = AtParser.parseClcc(await this.modem.executeCommand('AT+CLCC', 5000));
        const voice = calls.filter((call) => call.mode === 0);
        if (voice.some((call) => call.status === 0)) {
          report.call = 'usable';
        } else if (voice.length === 0) {
          report.call = 'lost';
        } else {
          report.call = 'unknown';
          report.notes.push(`Module lists the call in state ${voice[0].status}, not active`);
        }
      } catch (error) {
        report.call = 'unknown';
        report.notes.push(
          portDropped(error)
            ? 'AT port dropped while asking for the call list'
            : `Could not query the module's call list: ${(error as Error).message}`
        );
      }
      if (superseded()) return abandon();

      if (report.call === 'lost') {
        report.notes.push('Module lists no voice call; ending the stale gateway call');
        this.clearDialTimer();
        this.pendingTerminationReason = 'Call lost during modem reconnect';
        if (this.audio) await this.audio.stopSession().catch(() => {});
        // Documented: AT+CPCMREG=0 is issued once the call has stopped. Also clears the activated flag.
        await this.deactivateUsbAudioDiagnostic().catch(() => {});
        if (sm.getState() === 'ACTIVE') {
          this.applyTransition(sm, 'TERMINATING', {
            outcome: 'failed',
            reason: 'Call lost during modem reconnect',
            trigger: 'modem-reconnect-recovery',
          });
          this.finalizeCall(sm);
        }
        return finish();
      }
      if (report.call === 'unknown') {
        report.notes.push('Call state could not be verified; registration and audio port left untouched');
        return finish();
      }

      const wanted = this.usbAudioDiagnosticActive;

      // 2. Reopen COM26 first, so any registration is made against the handle that will receive the bytes.
      if (this.audio?.recoverSession) {
        try {
          if (this.audio.getStats().isStreaming) {
            // The adapter flags any port close itself, so a still-streaming session never lost its handle.
            report.audioPort = 'still-open';
          } else {
            await this.audio.recoverSession();
            report.audioPort = 'reopened';
          }
        } catch (error) {
          report.audioPort = 'failed';
          report.notes.push(`Audio port could not be reopened: ${(error as Error).message}`);
        }
      }
      if (superseded()) return abandon();

      // 3. Is the USB audio registration still set? Re-issued only if the operator had activated it.
      if (wanted) {
        try {
          const registered = AtParser.parsePrefixedIntegers(
            await this.modem.executeCommand('AT+CPCMREG?', 3000),
            'CPCMREG'
          );
          if (registered && registered[0] === 1) {
            report.registration = 'verified';
          } else if (registered && registered[0] === 0) {
            const response = await this.modem.executeCommand('AT+CPCMREG=1', 5000);
            report.registration = /\bOK\b/.test(response) ? 'reissued' : 'failed';
          } else {
            report.registration = 'unknown';
            report.notes.push('AT+CPCMREG? gave no readable answer');
          }
        } catch (error) {
          report.registration = portDropped(error) ? 'unknown' : 'failed';
          report.notes.push(`Registration check did not complete: ${(error as Error).message}`);
        }
        if (superseded()) return abandon();
      }

      // 4. A registration flag is not a stream: wait for real PCM bytes. If the module says it is registered and
      //    nothing arrives, that is reported as found. There is deliberately no stop/start toggle here: SIMCom
      //    documents AT+CPCMREG=0 only after the call has stopped, and this module rejects it mid-call.
      const registered = report.registration === 'verified' || report.registration === 'reissued';
      if (this.audio && wanted && registered && (report.audioPort === 'reopened' || report.audioPort === 'still-open')) {
        const flowing = await this.waitForAudioBytes(USB_AUDIO_FLOW_WAIT_MS, USB_AUDIO_FLOW_MIN_BYTES);
        if (superseded()) return abandon();
        report.audioFlowing = flowing;
        if (!flowing) {
          report.notes.push(
            report.registration === 'verified'
              ? 'Registered but no PCM bytes received: AT+CPCMREG? reports 1, the audio port was checked, and no sustained PCM arrived. Nothing was toggled; audio is unhealthy and not recovered'
              : 'Registration was re-issued (AT+CPCMREG=1 accepted) but no PCM bytes received; audio is unhealthy and not recovered'
          );
        }
      }

      // Anything not proven by bytes on the wire leaves the session unhealthy, so the PCM tests refuse it.
      if (wanted) this.usbAudioStale = report.audioFlowing !== true;
      this.modemLostDuringCall = false;
      return finish();
    } catch (error) {
      report.notes.push(`Recovery aborted: ${(error as Error).message}`);
      if (this.usbAudioDiagnosticActive) this.usbAudioStale = true;
      return finish();
    }
  }

  /** Resolves true once at least `minBytes` of inbound PCM have arrived inside the window. */
  private waitForAudioBytes(timeoutMs: number, minBytes: number): Promise<boolean> {
    const audio = this.audio;
    if (!audio) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let received = 0;
      const done = (flowing: boolean) => {
        clearTimeout(timer);
        audio.off('audio_frame', onFrame);
        resolve(flowing);
      };
      const onFrame = (frame: { data: Buffer }) => {
        received += frame.data.length;
        if (received >= minBytes) done(true);
      };
      const timer = setTimeout(() => done(false), timeoutMs);
      audio.on('audio_frame', onFrame);
    });
  }

  private handleUrc(urc: UrcEvent): void {
    this.logger.info(
      `Call URC ${urc.type} received: ${redactDiagnosticText(urc.raw)}`
    );
    this.eventBus?.emit('modem:urc', urc);

    if (urc.type === 'CLIP') {
      const clip = urc as ClipUrcEvent;
      this.handleIncomingRing(clip.phoneNumber, true);
      return;
    }

    if (urc.type === 'RING') {
      this.handleIncomingRing('Unknown', false);
      return;
    }

    if (urc.type === 'VOICE_CALL_BEGIN') {
      if (
        this.activeStateMachine &&
        (this.activeStateMachine.getState() === 'DIALING' ||
          this.activeStateMachine.getState() === 'OUTBOUND_RINGING')
      ) {
        this.clearDialTimer();
        this.applyTransition(this.activeStateMachine, 'ACTIVE', urcTrigger(urc));
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
          ...this.endTrigger(urc),
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
          ...this.endTrigger(urc),
        });
        this.finalizeCall(this.activeStateMachine);
      }
      return;
    }

    if (urc.type === 'CUSTOM' && urc.payload?.status === 'alerting') {
      if (this.activeStateMachine && this.activeStateMachine.getState() === 'DIALING') {
        this.applyTransition(this.activeStateMachine, 'OUTBOUND_RINGING', { trigger: 'urc:CUSTOM:alerting' });
      }
    }
  }

  /**
   * Handle a RING/+CRING (no caller ID) or +CLIP (caller ID) URC.
   * The modem emits RING and +CLIP for the same incoming call, repeating both every ring cycle,
   * so these URCs must be correlated with an already-ringing inbound session instead of being
   * treated as a second concurrent call.
   */
  private handleIncomingRing(phoneNumber: string, hasCallerId: boolean): void {
    const now = Date.now();
    let current = this.activeStateMachine;

    // STALE SESSION GUARD: an inbound session that stopped ringing without a terminating URC
    // (e.g. missed NO CARRIER) must not swallow or reject a brand-new incoming call.
    if (
      current &&
      current.getState() === 'INBOUND_RINGING' &&
      now - this.lastInboundRingAt > INBOUND_RING_STALE_MS
    ) {
      this.logger.warn(
        `Discarding stale inbound session ${current.getSession().id}: no ring URC for ${now - this.lastInboundRingAt}ms`
      );
      this.applyTransition(current, 'TERMINATING', {
        outcome: 'missed',
        reason: 'Inbound ringing session went stale before a new call arrived',
        trigger: 'stale-inbound-session',
      });
      this.finalizeCall(current);
      current = null;
    }

    // SAME-CALL CORRELATION: repeated RING / +CLIP URCs for the call that is already ringing
    // keep it ringing; a +CLIP only fills in the caller ID if it was not known yet.
    if (current && current.getState() === 'INBOUND_RINGING') {
      this.lastInboundRingAt = now;
      this.armInboundRingExpiry();
      if (hasCallerId) {
        const session = current.getSession();
        if (session.remoteNumber !== phoneNumber) {
          current.setRemoteNumber(phoneNumber);
          const event: CallStateChangeEvent = {
            callId: session.id,
            previousState: 'INBOUND_RINGING',
            currentState: 'INBOUND_RINGING',
            timestamp: new Date().toISOString(),
            session: current.getSession(),
          };
          this.emit('call:state_changed', event);
          this.eventBus?.emit('call:state_changed', event);
        }
      }
      return;
    }

    // SINGLE CONCURRENT CALL GUARD:
    // If another call is already active or in progress, reject this inbound call immediately
    if (current && current.getState() !== 'IDLE') {
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

    this.lastInboundRingAt = now;
    this.armInboundRingExpiry();
    this.applyTransition(sm, 'INBOUND_RINGING', { trigger: 'urc:RING' });
    this.emit('call:started', sm.getSession());
    this.eventBus?.emit('call:started', sm.getSession());
  }

  /** An end URC that follows our own hangup request is labelled as such: the URC is the confirmation, not the cause. */
  private endTrigger(urc: UrcEvent): { trigger: string; triggerLine?: string } {
    const t = urcTrigger(urc);
    return this.pendingTerminationReason ? { ...t, trigger: `hangup-requested>${t.trigger}` } : t;
  }

  private applyTransition(
    sm: CallStateMachine,
    nextState: any,
    options?: { outcome?: CallOutcome; reason?: string; trigger?: string; triggerLine?: string }
  ): void {
    this.logger.info(
      `Call ${sm.getSession().id} state transition ${sm.getState()} -> ${nextState}${
        options?.reason ? ` (${redactDiagnosticText(options.reason)})` : ''
      }${options?.trigger ? ` trigger=${options.trigger}` : ''}${options?.triggerLine ? ` line="${options.triggerLine}"` : ''}`
    );
    const change = sm.transitionTo(nextState, { outcome: options?.outcome, reason: options?.reason });
    const event: CallStateChangeEvent = {
      callId: change.session.id,
      previousState: change.previousState,
      currentState: change.currentState,
      timestamp: new Date().toISOString(),
      session: change.session,
      ...(options?.trigger ? { trigger: options.trigger } : {}),
      ...(options?.triggerLine ? { triggerLine: options.triggerLine } : {}),
    };
    this.emit('call:state_changed', event);
    this.eventBus?.emit('call:state_changed', event);
  }

  private finalizeCall(sm: CallStateMachine): void {
    sm.transitionTo('IDLE');
    const endedSession = sm.getSession();
    this.activeStateMachine = null;
    this.pendingTerminationReason = undefined;
    this.modemLostDuringCall = false;
    this.clearInboundRingTimer();
    // A call must not hand its USB audio flag to the next one. If no accepted stop settled it (and none is still in
    // flight, which settles it itself), the registration is of unknown state, not active.
    if (this.usbAudioDiagnosticActive && !this.usbAudioDiagnosticDeactivation) {
      this.usbAudioDiagnosticActive = false;
      this.usbAudioRegistrationUncertain = true;
    }
    this.usbAudioStale = false;
    this.lastModuleAudioFormat = null;
    this.clearUsbRecoveryTimer();

    this.emit('call:ended', endedSession);
    this.eventBus?.emit('call:ended', endedSession);
  }

  /**
   * Every RING/+CLIP re-arms this. If the rings simply stop (the caller gave up and the modem never reported it, or
   * the modem's USB connection dropped mid-ring), the call can no longer be answered, so it ends as missed here
   * instead of staying "ringing" until some later call happens to replace it.
   */
  private armInboundRingExpiry(): void {
    this.clearInboundRingTimer();
    this.inboundRingTimer = setTimeout(() => {
      this.inboundRingTimer = null;
      const sm = this.activeStateMachine;
      if (!sm || sm.getState() !== 'INBOUND_RINGING') return;
      this.logger.warn(`Inbound call ${sm.getSession().id} stopped ringing (no ring URC for ${INBOUND_RING_STALE_MS}ms); recording it as missed`);
      this.applyTransition(sm, 'TERMINATING', {
        outcome: 'missed',
        reason: 'Ringing stopped without an end report from the modem',
        trigger: 'ring-expired',
      });
      this.finalizeCall(sm);
    }, INBOUND_RING_STALE_MS);
    this.inboundRingTimer.unref?.();
  }

  private clearInboundRingTimer(): void {
    if (this.inboundRingTimer) {
      clearTimeout(this.inboundRingTimer);
      this.inboundRingTimer = null;
    }
  }

  private clearDialTimer(): void {
    if (this.dialTimeoutTimer) {
      clearTimeout(this.dialTimeoutTimer);
      this.dialTimeoutTimer = null;
    }
  }
}

/** Protocol lines that carry no identifiers and are therefore safe to keep next to a state change. */
const SAFE_TRIGGER_LINE = /^(VOICE CALL: BEGIN|VOICE CALL: END(: \d+)?|CONNECT|NO CARRIER|NO ANSWER|BUSY)$/;

/** The URC behind a transition: its type, and its raw line only when it is one of the fixed, identifier-free lines. */
function urcTrigger(urc: UrcEvent): { trigger: string; triggerLine?: string } {
  const raw = typeof urc.raw === 'string' ? urc.raw.trim() : '';
  return {
    trigger: `urc:${urc.type}`,
    ...(SAFE_TRIGGER_LINE.test(raw) ? { triggerLine: raw } : {}),
  };
}
