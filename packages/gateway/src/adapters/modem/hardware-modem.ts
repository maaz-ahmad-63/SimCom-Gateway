import { EventEmitter } from 'node:events';
import {
  AtCommunicationStatus,
  IModemAdapter,
  ModemConnectionState,
  ModemDeviceInfo,
  ModemDriverType,
  ModemNetworkStatus,
  ModemPortConfig,
  ModemSignalQuality,
  SimPinStatus,
  UrcEvent,
  AtCommandError,
  SerialPortDisconnectedError,
} from '@sim-gateway/shared';
import { ISerialTransport, NodeSerialTransport } from './serial-transport.js';
import { AtCommandQueue } from './at-command-queue.js';
import { AtParser } from './at-parser.js';
import { createLogger, Logger } from '../../core/logger.js';

export interface HardwareModemOptions {
  atPort?: string;
  atBaudRate?: number;
  commandTimeoutMs?: number;
  dialTimeoutMs?: number;
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  transport?: ISerialTransport;
}

/**
 * Physical SIMCOM SIM7600EI hardware modem adapter.
 * Communicates over serial transport (e.g. COM20 on Windows host) using AT commands and URCs.
 */
export class Sim7600HardwareAdapter extends EventEmitter implements IModemAdapter {
  readonly driverType: ModemDriverType = 'hardware';
  readonly isSimulated = false;

  private connectionState: ModemConnectionState = 'DISCONNECTED';
  private transport: ISerialTransport;
  private queue: AtCommandQueue;
  private config: ModemPortConfig;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private isClosing = false;
  private serialFailureHandled = false;
  private readonly logger: Logger;

  constructor(options: HardwareModemOptions = {}) {
    super();

    this.config = {
      atPort: options.atPort ?? 'COM20',
      atBaudRate: options.atBaudRate ?? 115200,
      audioPort: 'COM19',
      audioBaudRate: 115200,
      commandTimeoutMs: options.commandTimeoutMs ?? 5000,
      dialTimeoutMs: options.dialTimeoutMs ?? 20000,
      autoReconnect: options.autoReconnect ?? true,
      reconnectIntervalMs: options.reconnectIntervalMs ?? 3000,
      maxReconnectAttempts: options.maxReconnectAttempts ?? 10,
    };

    this.logger = createLogger(`Modem:${this.config.atPort}`);

    // Inject transport (for tests) or create NodeSerialTransport
    this.transport =
      options.transport ??
      new NodeSerialTransport({
        path: this.config.atPort,
        baudRate: this.config.atBaudRate,
        lock: true,
      });

    this.queue = new AtCommandQueue(this.transport, {
      defaultTimeoutMs: this.config.commandTimeoutMs,
    });

    this.setupListeners();
  }

  private setupListeners(): void {
    // Forward parsed URCs from the AT queue
    this.queue.on('urc', (urc: UrcEvent) => {
      this.emit('urc', urc);
    });

    // Handle transport errors and unexpected disconnections
    this.transport.on('error', (err: Error) => {
      this.handleSerialFailure(err);
    });

    this.transport.on('close', () => {
      if (!this.isClosing && this.connectionState !== 'DISCONNECTED') {
        this.handleSerialFailure(
          new SerialPortDisconnectedError(this.config.atPort, 'Modem serial connection closed')
        );
      }
    });
  }

  getConnectionState(): ModemConnectionState {
    return this.connectionState;
  }

  private setConnectionState(state: ModemConnectionState): void {
    if (this.connectionState !== state) {
      const prev = this.connectionState;
      this.connectionState = state;
      this.logger.info(`Connection state changed: ${prev} -> ${state}`);
      this.emit('connection_state', state);
    }
  }

  async initialize(configOverrides?: Partial<ModemPortConfig>): Promise<void> {
    if (configOverrides) {
      this.config = { ...this.config, ...configOverrides };
    }

    this.isClosing = false;
    this.logger.info(`Initializing hardware modem on ${this.config.atPort} @ ${this.config.atBaudRate} baud`);
    this.setConnectionState('CONNECTING');

    try {
      // 1. Open Serial Port
      if (!this.transport.isOpen()) {
        await this.transport.open({
          path: this.config.atPort,
          baudRate: this.config.atBaudRate,
        });
      }
      this.queue.markTransportReady();

      this.setConnectionState('INITIALIZING');

      // 2. UART Stabilization delay
      await this.delay(100);

      // 3. Basic sync test
      try {
        await this.queue.execute('AT', 2000);
      } catch {
        // Retry once after short delay in case modem was waking up
        this.logger.debug('Modem AT sync retry after 200ms delay...');
        await this.delay(200);
        await this.queue.execute('AT', 2000);
      }

      // 4. Modem initialization sequence:
      // ATE0: Disable echo so responses are clean
      await this.queue.execute('ATE0', 2000);

      // AT+CMEE=2: Enable verbose error reporting
      await this.queue.execute('AT+CMEE=2', 2000);

      // AT+CLIP=1: Enable Caller ID URCs (+CLIP: "+91...",145)
      await this.queue.execute('AT+CLIP=1', 2000);

      // AT+CRC=1: Enable cellular extended ring reporting
      await this.queue.execute('AT+CRC=1', 2000);

      // 5. Check SIM card presence
      const cpinResp = await this.queue.execute('AT+CPIN?', 3000);
      const pinStatus = AtParser.parseCpin(cpinResp);
      if (pinStatus !== 'READY') {
        throw new Error(`SIM card is not ready (Status: ${pinStatus})`);
      }

      // Reconnect counter reset on successful initialization
      this.reconnectAttempts = 0;
      this.serialFailureHandled = false;
      this.setConnectionState('READY');
      this.logger.info(`Hardware modem on ${this.config.atPort} ready for cellular operations`);
    } catch (initErr) {
      this.logger.error(`Modem initialization failed on ${this.config.atPort}: ${(initErr as Error).message}`);
      this.setConnectionState('ERROR');
      if (this.listenerCount('error') > 0) {
        this.emit('error', initErr as Error);
      }

      if (this.config.autoReconnect && !this.isClosing) {
        this.scheduleReconnect();
      }
      throw initErr;
    }
  }

  async close(): Promise<void> {
    this.isClosing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.queue.reset();
      this.queue.markTransportClosing();
      await this.transport.close();
    } finally {
      this.setConnectionState('DISCONNECTED');
    }
  }

  async executeCommand(command: string, timeoutMs?: number): Promise<string> {
    return this.queue.execute(command, timeoutMs);
  }

  async dial(phoneNumber: string): Promise<void> {
    // Standard cellular voice calls require a trailing semicolon
    const cleanNumber = phoneNumber.trim();
    const command = `ATD${cleanNumber};`;

    try {
      const response = await this.queue.execute(command, this.config.dialTimeoutMs);
      if (!response.includes('OK')) {
        throw new AtCommandError(command, response, `Dial rejected by cellular network: ${response}`);
      }
    } catch (dialErr) {
      throw dialErr;
    }
  }

  async answer(): Promise<void> {
    const response = await this.queue.execute('ATA', 5000);
    if (!response.includes('OK')) {
      throw new AtCommandError('ATA', response, `Failed to answer incoming call: ${response}`);
    }
  }

  async hangup(): Promise<void> {
    try {
      // First try AT+CHUP (standard 3GPP call hangup)
      const response = await this.queue.execute('AT+CHUP', 5000);
      if (response.includes('OK')) return;
    } catch {
      // Fallback to legacy ATH
      await this.queue.execute('ATH', 5000);
    }
  }

  async sendDtmf(digit: string): Promise<void> {
    const cleanDigit = digit.trim().charAt(0);
    if (!cleanDigit) return;
    await this.queue.execute(`AT+VTS=${cleanDigit}`, 3000);
  }

  async getSignalQuality(): Promise<ModemSignalQuality> {
    const response = await this.queue.execute('AT+CSQ', 3000);
    return AtParser.parseCsq(response);
  }

  async getNetworkStatus(): Promise<ModemNetworkStatus> {
    let regStatus = 'UNKNOWN' as any;
    let operatorName: string | null = null;
    let accessTechnology: 'GSM' | 'UMTS' | 'LTE' | 'UNKNOWN' = 'UNKNOWN';

    // 1. Try AT+CEREG? (LTE registration query)
    try {
      const ceregResp = await this.queue.execute('AT+CEREG?', 3000);
      regStatus = AtParser.parseCregOrCereg(ceregResp);
    } catch {
      // Fallback to AT+CREG? (Circuit-switched GSM/UMTS registration)
      try {
        const cregResp = await this.queue.execute('AT+CREG?', 3000);
        regStatus = AtParser.parseCregOrCereg(cregResp);
      } catch {
        regStatus = 'UNKNOWN';
      }
    }

    // 2. Query Operator Name (AT+COPS?)
    try {
      const copsResp = await this.queue.execute('AT+COPS?', 5000);
      const parsed = AtParser.parseCops(copsResp);
      operatorName = parsed.operatorName;
      accessTechnology = parsed.accessTechnology;
    } catch {
      operatorName = null;
    }

    return {
      registration: regStatus,
      operatorName,
      accessTechnology,
      timestamp: new Date().toISOString(),
    };
  }

  async getDeviceInfo(): Promise<ModemDeviceInfo> {
    let atiResponse = '';
    let imeiResponse = '';
    let imsiResponse = '';

    try {
      atiResponse = await this.queue.execute('ATI', 3000);
    } catch {
      atiResponse = 'Manufacturer: SIMCOM\nModel: SIMCOM_SIM7600EI\nRevision: SIM7600M21-A_V1.1';
    }

    try {
      imeiResponse = await this.queue.execute('AT+CGSN', 3000);
    } catch {
      // Optional query
    }

    try {
      imsiResponse = await this.queue.execute('AT+CIMI', 3000);
    } catch {
      // Optional query
    }

    return AtParser.parseDeviceInfo(atiResponse, imeiResponse, imsiResponse);
  }

  private handleSerialFailure(error: Error): void {
    if (this.isClosing || this.serialFailureHandled) return;

    this.serialFailureHandled = true;
    this.setConnectionState('ERROR');
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }

    if (this.config.autoReconnect) {
      this.scheduleReconnect();
    }
  }

  /** Query current SIM PIN/PUK/Ready status directly */
  async getSimStatus(): Promise<SimPinStatus> {
    try {
      const response = await this.queue.execute('AT+CPIN?', 3000);
      return AtParser.parseCpin(response);
    } catch (err) {
      this.logger.warn(`Failed to query SIM status: ${(err as Error).message}`);
      return 'ERROR';
    }
  }

  getLastCommunicationTime(): string | null {
    return this.queue.getLastCommunicationTime();
  }

  getAtCommunicationStatus(): AtCommunicationStatus {
    if (this.connectionState === 'DISCONNECTED') {
      return 'DISCONNECTED';
    }
    return this.queue.getAtCommunicationStatus();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isClosing) return;

    if (
      this.config.maxReconnectAttempts &&
      this.reconnectAttempts >= this.config.maxReconnectAttempts
    ) {
      if (this.listenerCount('error') > 0) {
        this.emit(
          'error',
          new Error(`Max reconnect attempts (${this.config.maxReconnectAttempts}) reached for ${this.config.atPort}`)
        );
      }
      this.setConnectionState('DISCONNECTED');
      return;
    }

    this.reconnectAttempts++;
    const interval = (this.config.reconnectIntervalMs ?? 3000) * Math.min(this.reconnectAttempts, 4);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.isClosing) return;

      try {
        await this.initialize();
      } catch {
        // Reconnect failure will automatically reschedule via initialize catch block
      }
    }, interval);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
