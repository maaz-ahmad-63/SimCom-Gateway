import { EventEmitter } from 'node:events';
import {
  AtCommandError,
  AtCommunicationStatus,
  IModemAdapter,
  ModemConnectionState,
  ModemDeviceInfo,
  ModemDriverType,
  ModemNetworkStatus,
  ModemPortConfig,
  ModemSignalQuality,
  SerialPortDisconnectedError,
  SimPinStatus,
  UrcEvent,
} from '@sim-gateway/shared';
import { describeClose, ISerialTransport, NodeSerialTransport, SerialCloseInfo } from './serial-transport.js';
import { AtCommandQueue } from './at-command-queue.js';
import { AtParser } from './at-parser.js';
import { createLogger, Logger, redactDiagnosticText } from '../../core/logger.js';

export interface A7672sOptions {
  /** AT interface (COM27 in this installation). Required: no COM number is assumed. */
  atPort: string;
  /** Diagnostics interface (COM29). Recorded for reporting only: this adapter never opens it and never sends it AT commands. */
  diagPort?: string;
  atBaudRate?: number;
  commandTimeoutMs?: number;
  dialTimeoutMs?: number;
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  /** How often AT+CLCC is read while a call exists, to confirm call state when the voice URCs are missing. 0 turns it off. */
  callPollMs?: number;
  transport?: ISerialTransport;
}

/** +CLCC stat values (3GPP TS 27.007). */
const CLCC_ACTIVE = 0;

/**
 * SIMCom A7672S through its own AT port.
 *
 * Differs from the SIM7600EI adapter on purpose:
 *  - It never uses AT+CPCMREG / USB PCM: this module's call audio is the analog K12 interface, handled outside this class.
 *  - Call state is confirmed with AT+CLCC while a call exists, because the "VOICE CALL: BEGIN/END" URCs of the SIM7600 are not
 *    assumed to exist on this firmware. A URC, if the modem sends one, is used as is; the poll only fills the gap.
 *  - The init sequence sends only commands that are standard 3GPP / A76xx baseline: AT, ATE0, AT+CMEE=2, AT+CLIP=1, AT+CPIN?.
 *
 * The command set follows SIMCom's public A76xx AT manual and has NOT been checked against this unit's firmware.
 */
export class A7672sAdapter extends EventEmitter implements IModemAdapter {
  readonly driverType: ModemDriverType = 'hardware';
  readonly isSimulated = false;

  private connectionState: ModemConnectionState = 'DISCONNECTED';
  private readonly transport: ISerialTransport;
  private readonly queue: AtCommandQueue;
  private config: ModemPortConfig;
  private readonly callPollMs: number;
  private readonly logger: Logger;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private initInFlight: Promise<void> | null = null;
  private isClosing = false;
  private serialFailureHandled = false;
  private releasingHandle = false;
  private lastFailure: { at: string; message: string } | null = null;

  /** A call is known to exist (ringing, dialing or active) and is being watched. */
  private callWatched = false;
  private callConnected = false;
  private callSeenByPoll = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(private readonly options: A7672sOptions) {
    super();
    this.config = {
      atPort: options.atPort,
      atBaudRate: options.atBaudRate ?? 115200,
      audioPort: '',
      audioBaudRate: 0,
      commandTimeoutMs: options.commandTimeoutMs ?? 5000,
      dialTimeoutMs: options.dialTimeoutMs ?? 20000,
      autoReconnect: options.autoReconnect ?? true,
      reconnectIntervalMs: options.reconnectIntervalMs ?? 3000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
    };
    this.callPollMs = options.callPollMs ?? 1500;
    this.logger = createLogger(`Modem:${options.atPort}`);
    this.transport = options.transport ?? new NodeSerialTransport({ path: this.config.atPort, baudRate: this.config.atBaudRate, lock: true });
    this.queue = new AtCommandQueue(this.transport, { defaultTimeoutMs: this.config.commandTimeoutMs });

    this.queue.on('urc', (urc: UrcEvent) => this.onUrc(urc));
    this.transport.on('error', (err: Error) => this.handleSerialFailure(err));
    this.transport.on('close', (info?: SerialCloseInfo) => {
      if (this.releasingHandle) return;
      if (!this.isClosing && this.connectionState !== 'DISCONNECTED') {
        this.handleSerialFailure(new SerialPortDisconnectedError(this.config.atPort, `Modem serial connection ${describeClose(info)}`));
      }
    });
  }

  /** What the adapter knows about itself. Sends no AT command. */
  getDiagnostics() {
    return {
      connectionState: this.connectionState,
      atPort: this.config.atPort,
      diagPort: this.options.diagPort ?? null,
      diagPortOpened: false,
      reconnectAttempts: this.reconnectAttempts,
      reconnectScheduled: this.reconnectTimer !== null,
      lastFailure: this.lastFailure,
      callWatched: this.callWatched,
    };
  }

  getConnectionState(): ModemConnectionState {
    return this.connectionState;
  }

  private setConnectionState(state: ModemConnectionState): void {
    if (this.connectionState === state) return;
    const prev = this.connectionState;
    this.connectionState = state;
    this.logger.info(`Connection state changed: ${prev} -> ${state}`);
    this.emit('connection_state', state);
  }

  initialize(overrides?: Partial<ModemPortConfig>): Promise<void> {
    if (this.initInFlight) return this.initInFlight;
    const run = this.runInitialize(overrides).finally(() => {
      if (this.initInFlight === run) this.initInFlight = null;
    });
    this.initInFlight = run;
    return run;
  }

  private async runInitialize(overrides?: Partial<ModemPortConfig>): Promise<void> {
    // Only the AT port may be overridden: an audio port from the shared config must never be applied to this modem.
    if (overrides?.atPort) this.config = { ...this.config, atPort: overrides.atPort };
    this.isClosing = false;
    let step = 'open-port';
    this.setConnectionState('CONNECTING');
    try {
      if (this.serialFailureHandled && this.transport.isOpen()) {
        this.releasingHandle = true;
        try {
          await this.transport.close();
        } finally {
          this.releasingHandle = false;
        }
      }
      if (!this.transport.isOpen()) await this.transport.open({ path: this.config.atPort, baudRate: this.config.atBaudRate });
      this.queue.markTransportReady();
      this.setConnectionState('INITIALIZING');
      step = 'at-sync';
      await this.delay(100);
      try {
        await this.queue.execute('AT', 2000);
      } catch {
        await this.delay(200);
        await this.queue.execute('AT', 2000);
      }
      for (const [name, command, timeout] of [
        ['ATE0', 'ATE0', 2000],
        ['AT+CMEE', 'AT+CMEE=2', 2000],
        ['AT+CLIP', 'AT+CLIP=1', 2000],
      ] as const) {
        step = name;
        await this.queue.execute(command, timeout);
      }
      step = 'AT+CPIN';
      const pin = AtParser.parseCpin(await this.queue.execute('AT+CPIN?', 3000));
      if (pin !== 'READY') throw new Error(`SIM card is not ready (Status: ${pin})`);
      this.reconnectAttempts = 0;
      this.serialFailureHandled = false;
      this.setConnectionState('READY');
      this.logger.info(`A7672S on ${this.config.atPort} ready`);
    } catch (err) {
      const message = redactDiagnosticText((err as Error).message);
      this.lastFailure = { at: new Date().toISOString(), message };
      this.logger.error(`A7672S init failed on ${this.config.atPort} at step ${step}: ${message}`);
      this.setConnectionState('ERROR');
      if (this.listenerCount('error') > 0) this.emit('error', err as Error);
      if (this.config.autoReconnect && !this.isClosing) this.scheduleReconnect();
      throw err;
    }
  }

  async close(): Promise<void> {
    this.isClosing = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopWatching();
    try {
      this.queue.reset();
      this.queue.markTransportClosing();
      await this.transport.close();
    } finally {
      this.setConnectionState('DISCONNECTED');
    }
  }

  executeCommand(command: string, timeoutMs?: number): Promise<string> {
    return this.queue.execute(command, timeoutMs);
  }

  async dial(phoneNumber: string): Promise<void> {
    const command = `ATD${phoneNumber.trim()};`;
    const response = await this.queue.execute(command, this.config.dialTimeoutMs);
    if (!response.includes('OK')) throw new AtCommandError(command, response, `Dial rejected by cellular network: ${response}`);
    this.watchCall();
  }

  async answer(): Promise<void> {
    const response = await this.queue.execute('ATA', 5000);
    if (!response.includes('OK')) throw new AtCommandError('ATA', response, `Failed to answer incoming call: ${response}`);
    this.watchCall();
  }

  async hangup(): Promise<void> {
    try {
      const response = await this.queue.execute('AT+CHUP', 5000);
      if (response.includes('OK')) return;
    } catch {
      await this.queue.execute('ATH', 5000);
    }
  }

  async sendDtmf(digit: string): Promise<void> {
    const d = digit.trim().charAt(0);
    if (d) await this.queue.execute(`AT+VTS=${d}`, 3000);
  }

  async getSignalQuality(): Promise<ModemSignalQuality> {
    return AtParser.parseCsq(await this.queue.execute('AT+CSQ', 3000));
  }

  async getNetworkStatus(): Promise<ModemNetworkStatus> {
    let registration = 'UNKNOWN' as ModemNetworkStatus['registration'];
    try {
      registration = AtParser.parseCregOrCereg(await this.queue.execute('AT+CEREG?', 3000));
    } catch {
      try {
        registration = AtParser.parseCregOrCereg(await this.queue.execute('AT+CREG?', 3000));
      } catch {
        // leave UNKNOWN
      }
    }
    let operatorName: string | null = null;
    let accessTechnology: ModemNetworkStatus['accessTechnology'] = 'UNKNOWN';
    try {
      const cops = AtParser.parseCops(await this.queue.execute('AT+COPS?', 5000));
      operatorName = cops.operatorName;
      accessTechnology = cops.accessTechnology;
    } catch {
      // optional
    }
    return { registration, operatorName, accessTechnology, timestamp: new Date().toISOString() };
  }

  async getDeviceInfo(): Promise<ModemDeviceInfo> {
    let ati = '';
    let imei = '';
    let imsi = '';
    try {
      ati = await this.queue.execute('ATI', 3000);
    } catch {
      ati = 'Manufacturer: SIMCOM\nModel: A7672S\nRevision: unknown';
    }
    try {
      imei = await this.queue.execute('AT+CGSN', 3000);
    } catch {
      // optional
    }
    try {
      imsi = await this.queue.execute('AT+CIMI', 3000);
    } catch {
      // optional
    }
    return AtParser.parseDeviceInfo(ati, imei, imsi);
  }

  async getSimStatus(): Promise<SimPinStatus> {
    try {
      return AtParser.parseCpin(await this.queue.execute('AT+CPIN?', 3000));
    } catch {
      return 'ERROR';
    }
  }

  getLastCommunicationTime(): string | null {
    return this.queue.getLastCommunicationTime();
  }

  getAtCommunicationStatus(): AtCommunicationStatus {
    return this.connectionState === 'DISCONNECTED' ? 'DISCONNECTED' : this.queue.getAtCommunicationStatus();
  }

  // --- call tracking -------------------------------------------------------------------------------------------

  private onUrc(urc: UrcEvent): void {
    switch (urc.type) {
      case 'RING':
      case 'CLIP':
        this.watchCall();
        break;
      case 'VOICE_CALL_BEGIN':
        this.callConnected = true;
        this.watchCall();
        break;
      case 'VOICE_CALL_END':
      case 'NO_CARRIER':
      case 'NO_ANSWER':
      case 'BUSY':
        this.stopWatching();
        break;
    }
    this.emit('urc', urc);
  }

  private watchCall(): void {
    this.callWatched = true;
    if (this.pollTimer || this.callPollMs <= 0) return;
    this.pollTimer = setInterval(() => void this.pollCall(), this.callPollMs);
    this.pollTimer.unref?.();
  }

  private stopWatching(): void {
    this.callWatched = false;
    this.callConnected = false;
    this.callSeenByPoll = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** Read AT+CLCC and report what the modem says about the call. Only runs while a call is being watched. */
  private async pollCall(): Promise<void> {
    if (this.polling || !this.callWatched || this.connectionState !== 'READY') return;
    this.polling = true;
    try {
      const calls = AtParser.parseClcc(await this.queue.execute('AT+CLCC', 3000));
      if (!this.callWatched) return;
      if (calls.length === 0) {
        // Gone after having been seen: the call ended and the modem sent no end URC.
        if (this.callSeenByPoll || this.callConnected) this.synthesize('NO CARRIER');
        return;
      }
      this.callSeenByPoll = true;
      if (!this.callConnected && calls.some((c) => c.status === CLCC_ACTIVE)) this.synthesize('VOICE CALL: BEGIN');
    } catch {
      // A failed poll says nothing about the call; the next one tries again.
    } finally {
      this.polling = false;
    }
  }

  /** Report a call event that was derived from AT+CLCC, in exactly the form the call manager already understands. */
  private synthesize(line: string): void {
    const urc = AtParser.parseUrc(line);
    if (urc) this.onUrc(urc);
  }

  // --- connection recovery -------------------------------------------------------------------------------------

  private handleSerialFailure(error: Error): void {
    if (this.isClosing || this.serialFailureHandled) return;
    this.serialFailureHandled = true;
    this.lastFailure = { at: new Date().toISOString(), message: redactDiagnosticText(error.message) };
    this.stopWatching();
    this.setConnectionState('ERROR');
    if (this.listenerCount('error') > 0) this.emit('error', error);
    if (this.config.autoReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isClosing) return;
    const max = this.config.maxReconnectAttempts;
    if (max && this.reconnectAttempts >= max) {
      if (this.listenerCount('error') > 0) this.emit('error', new Error(`Max reconnect attempts (${max}) reached for ${this.config.atPort}`));
      this.setConnectionState('DISCONNECTED');
      return;
    }
    this.reconnectAttempts++;
    const delay = (this.config.reconnectIntervalMs ?? 3000) * Math.min(this.reconnectAttempts, 4);
    this.logger.warn(`A7672S reconnect scheduled: attempt=${this.reconnectAttempts} delayMs=${delay} port=${this.config.atPort}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.isClosing) return;
      this.initialize().catch(() => {}); // a failure reschedules itself
    }, delay);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
