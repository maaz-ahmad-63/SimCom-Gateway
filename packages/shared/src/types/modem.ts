/**
 * Modem adapter interface, status types, and URC definitions
 * Compatible with SIMCOM SIM7600EI series.
 */

export type ModemDriverType = 'hardware' | 'mock';

export type ModemConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'INITIALIZING'
  | 'READY'
  | 'ERROR';

export type NetworkRegistrationStatus =
  | 'NOT_REGISTERED'
  | 'REGISTERED_HOME'
  | 'SEARCHING'
  | 'REGISTRATION_DENIED'
  | 'UNKNOWN'
  | 'REGISTERED_ROAMING';

export type SimPinStatus =
  | 'READY'
  | 'SIM_PIN'
  | 'SIM_PUK'
  | 'ERROR'
  | 'UNKNOWN'
  | 'UNAVAILABLE'
  | 'DISCONNECTED';

export type AtCommunicationStatus =
  | 'OK'
  | 'TIMEOUT'
  | 'ERROR'
  | 'UNKNOWN'
  | 'DISCONNECTED';

export interface ModemSignalQuality {
  /** Raw RSSI from AT+CSQ (0-31, or 99 for unknown) */
  rssi: number;
  /** Bit error rate (0-7, or 99 for unknown) */
  ber: number;
  /** Estimated dBm (-113 to -51 dBm) */
  dBm: number | null;
  /** Normalized signal strength rating (0 - 5 bars) */
  bars: number;
  timestamp: string;
}

export interface ModemNetworkStatus {
  registration: NetworkRegistrationStatus;
  operatorName: string | null;
  accessTechnology: 'GSM' | 'UMTS' | 'LTE' | 'UNKNOWN';
  timestamp: string;
}

export interface ModemDeviceInfo {
  manufacturer: string;
  model: string;
  firmwareRevision: string;
  imei?: string;
  imsi?: string;
  isSimulated: boolean;
}

export interface ModemPortConfig {
  atPort: string;
  atBaudRate: number;
  audioPort: string;
  audioBaudRate: number;
  lockPort?: boolean;
  commandTimeoutMs?: number;
  dialTimeoutMs?: number;
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
}

export class AtCommandError extends Error {
  readonly command: string;
  readonly rawResponse: string;

  constructor(command: string, rawResponse: string, message?: string) {
    super(message ?? `AT command failed: ${command} -> ${rawResponse}`);
    this.name = 'AtCommandError';
    this.command = command;
    this.rawResponse = rawResponse;
  }
}

export class AtCommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(`AT command '${command}' timed out after ${timeoutMs}ms`);
    this.name = 'AtCommandTimeoutError';
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

export class SerialPortDisconnectedError extends Error {
  readonly portPath: string;

  constructor(portPath: string, message?: string) {
    super(message ?? `Serial port '${portPath}' disconnected or failed`);
    this.name = 'SerialPortDisconnectedError';
    this.portPath = portPath;
  }
}

export interface UrcEvent {
  raw: string;
  type:
    | 'RING'
    | 'CLIP'
    | 'NO_CARRIER'
    | 'NO_ANSWER'
    | 'BUSY'
    | 'VOICE_CALL_BEGIN'
    | 'VOICE_CALL_END'
    | 'SIGNAL_UPDATE'
    | 'REGISTRATION_UPDATE'
    | 'CUSTOM';
  payload?: Record<string, unknown>;
  timestamp: string;
  isSimulated: boolean;
}

export interface ClipUrcEvent extends UrcEvent {
  type: 'CLIP';
  phoneNumber: string;
  typeOfAddress: number;
}

export interface CallEndUrcEvent extends UrcEvent {
  type: 'VOICE_CALL_END';
  durationSeconds?: number;
}

/**
 * Common interface implemented by both Sim7600HardwareAdapter and MockModemAdapter.
 */
export interface IModemAdapter {
  readonly driverType: ModemDriverType;
  readonly isSimulated: boolean;
  getConnectionState(): ModemConnectionState;

  initialize(config?: Partial<ModemPortConfig>): Promise<void>;
  close(): Promise<void>;

  /** Execute raw AT command and await response */
  executeCommand(command: string, timeoutMs?: number): Promise<string>;

  /** Call control methods */
  dial(phoneNumber: string): Promise<void>;
  answer(): Promise<void>;
  hangup(): Promise<void>;
  sendDtmf(digit: string): Promise<void>;

  /** Diagnostic and status queries */
  getSignalQuality(): Promise<ModemSignalQuality>;
  getNetworkStatus(): Promise<ModemNetworkStatus>;
  getDeviceInfo(): Promise<ModemDeviceInfo>;
  getSimStatus?(): Promise<SimPinStatus>;
  getLastCommunicationTime?(): string | null;
  getAtCommunicationStatus?(): AtCommunicationStatus;

  /** Event listeners */
  on(event: 'urc', listener: (urc: UrcEvent) => void): this;
  on(event: 'connection_state', listener: (state: ModemConnectionState) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}
