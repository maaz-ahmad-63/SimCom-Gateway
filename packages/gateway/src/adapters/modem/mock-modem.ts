import { EventEmitter } from 'node:events';
import {
  IModemAdapter,
  ModemConnectionState,
  ModemDeviceInfo,
  ModemDriverType,
  ModemNetworkStatus,
  ModemPortConfig,
  ModemSignalQuality,
  UrcEvent,
  ClipUrcEvent,
  CallEndUrcEvent,
} from '@sim-gateway/shared';

export interface MockModemOptions {
  manufacturer?: string;
  model?: string;
  firmwareRevision?: string;
  carrierName?: string;
  initialRssi?: number;
  autoAnswerDelayMs?: number;
  ringIntervalMs?: number;
}

export class MockModemAdapter extends EventEmitter implements IModemAdapter {
  readonly driverType: ModemDriverType = 'mock';
  readonly isSimulated = true;

  private connectionState: ModemConnectionState = 'DISCONNECTED';
  private rssi: number;
  private carrierName: string;
  private isIncomingRinging = false;
  private ringTimer: NodeJS.Timeout | null = null;
  private ringCount = 0;
  private activeCallRemoteNumber: string | null = null;
  private callStartTimestamp: number | null = null;
  private readonly options: Required<MockModemOptions>;

  constructor(options: MockModemOptions = {}) {
    super();
    this.options = {
      manufacturer: options.manufacturer ?? 'SIMCOM',
      model: options.model ?? 'SIMCOM_SIM7600EI',
      firmwareRevision: options.firmwareRevision ?? 'SIM7600M21-A_V1.1',
      carrierName: options.carrierName ?? 'Vi India',
      initialRssi: options.initialRssi ?? 24,
      autoAnswerDelayMs: options.autoAnswerDelayMs ?? 3000,
      ringIntervalMs: options.ringIntervalMs ?? 3000,
    };
    this.rssi = this.options.initialRssi;
    this.carrierName = this.options.carrierName;

    this.on('urc', (urc: UrcEvent) => {
      if (urc.type === 'CLIP') {
        this.isIncomingRinging = true;
        this.activeCallRemoteNumber = (urc as ClipUrcEvent).phoneNumber;
      }
    });
  }

  getConnectionState(): ModemConnectionState {
    return this.connectionState;
  }

  async initialize(_config?: Partial<ModemPortConfig>): Promise<void> {
    this.connectionState = 'CONNECTING';
    this.emit('connection_state', this.connectionState);

    // Simulate serial handshake delay
    await this.delay(100);

    this.connectionState = 'READY';
    this.emit('connection_state', this.connectionState);
  }

  async close(): Promise<void> {
    this.stopRingLoop();
    this.connectionState = 'DISCONNECTED';
    this.emit('connection_state', this.connectionState);
  }

  async executeCommand(command: string, timeoutMs = 5000): Promise<string> {
    const trimmed = command.trim();
    await this.delay(40); // Realistic UART propagation latency

    if (trimmed === 'AT') {
      return 'OK';
    }
    if (trimmed.startsWith('ATE')) {
      return 'OK';
    }
    if (trimmed === 'ATI') {
      return `Manufacturer: ${this.options.manufacturer}\nModel: ${this.options.model}\nRevision: ${this.options.firmwareRevision}\nOK`;
    }
    if (trimmed === 'AT+CPIN?') {
      return '+CPIN: READY\nOK';
    }
    if (trimmed === 'AT+CSQ') {
      return `+CSQ: ${this.rssi},99\nOK`;
    }
    if (trimmed === 'AT+CREG?') {
      return '+CREG: 0,1\nOK';
    }
    if (trimmed === 'AT+COPS?') {
      return `+COPS: 0,0,"${this.carrierName}",7\nOK`;
    }
    if (trimmed.startsWith('AT+CLIP=')) {
      return 'OK';
    }
    if (trimmed.startsWith('ATD')) {
      const match = trimmed.match(/^ATD([^;]+);$/);
      if (!match) {
        throw new Error('AT ERROR: Invalid dial format');
      }
      const number = match[1];
      this.activeCallRemoteNumber = number;
      this.callStartTimestamp = Date.now();
      return 'OK';
    }
    if (trimmed === 'ATA') {
      if (!this.ringTimer && !this.isIncomingRinging && !this.activeCallRemoteNumber) {
        throw new Error('AT ERROR: No incoming call to answer');
      }
      this.stopRingLoop();
      this.isIncomingRinging = false;
      this.callStartTimestamp = Date.now();
      this.emitUrc({
        raw: 'VOICE CALL: BEGIN',
        type: 'VOICE_CALL_BEGIN',
        timestamp: new Date().toISOString(),
        isSimulated: true,
      });
      return 'OK';
    }
    if (trimmed === 'ATH' || trimmed === 'AT+CHUP') {
      const durationSeconds = this.callStartTimestamp
        ? Math.round((Date.now() - this.callStartTimestamp) / 1000)
        : 0;

      this.stopRingLoop();
      this.activeCallRemoteNumber = null;
      this.callStartTimestamp = null;

      const callEndEvent: CallEndUrcEvent = {
        raw: `VOICE CALL: END: ${durationSeconds}`,
        type: 'VOICE_CALL_END',
        durationSeconds,
        timestamp: new Date().toISOString(),
        isSimulated: true,
      };
      this.emitUrc(callEndEvent);
      return 'OK';
    }
    if (trimmed.startsWith('AT+VTS=')) {
      return 'OK';
    }
    if (trimmed.startsWith('AT+CPCMREG=')) {
      return 'OK';
    }

    return 'OK';
  }

  async dial(phoneNumber: string): Promise<void> {
    await this.executeCommand(`ATD${phoneNumber};`);

    // Simulate cellular network call progress
    setTimeout(() => {
      this.emitUrc({
        raw: 'ALERTING',
        type: 'CUSTOM',
        payload: { status: 'alerting' },
        timestamp: new Date().toISOString(),
        isSimulated: true,
      });
    }, 1500);

    // Auto-answer after configured delay
    if (this.options.autoAnswerDelayMs > 0) {
      setTimeout(() => {
        if (this.activeCallRemoteNumber) {
          this.emitUrc({
            raw: 'VOICE CALL: BEGIN',
            type: 'VOICE_CALL_BEGIN',
            timestamp: new Date().toISOString(),
            isSimulated: true,
          });
        }
      }, this.options.autoAnswerDelayMs);
    }
  }

  async answer(): Promise<void> {
    await this.executeCommand('ATA');
  }

  async hangup(): Promise<void> {
    await this.executeCommand('ATH');
  }

  async sendDtmf(digit: string): Promise<void> {
    await this.executeCommand(`AT+VTS=${digit}`);
  }

  async getSignalQuality(): Promise<ModemSignalQuality> {
    const dBm = this.rssi === 99 ? null : -113 + this.rssi * 2;
    const bars = Math.min(5, Math.max(0, Math.round((this.rssi / 31) * 5)));
    return {
      rssi: this.rssi,
      ber: 99,
      dBm,
      bars,
      timestamp: new Date().toISOString(),
    };
  }

  async getNetworkStatus(): Promise<ModemNetworkStatus> {
    return {
      registration: 'REGISTERED_HOME',
      operatorName: this.carrierName,
      accessTechnology: 'LTE',
      timestamp: new Date().toISOString(),
    };
  }

  async getDeviceInfo(): Promise<ModemDeviceInfo> {
    return {
      manufacturer: this.options.manufacturer,
      model: this.options.model,
      firmwareRevision: this.options.firmwareRevision,
      imei: '862000000000001',
      imsi: '404000000000001',
      isSimulated: true,
    };
  }

  // ===========================================================================
  // Simulation Control Hooks (For Dev / Testing / Scenarios)
  // ===========================================================================

  /** Simulates an incoming call with repeated GSM 3s RING cadence */
  simulateInboundCall(phoneNumber: string, maxRings = 5): void {
    this.stopRingLoop();
    this.activeCallRemoteNumber = phoneNumber;
    this.isIncomingRinging = true;
    this.ringCount = 0;

    const emitRing = () => {
      this.ringCount++;
      const clipEvent: ClipUrcEvent = {
        raw: `RING\r\n+CLIP: "${phoneNumber}",145`,
        type: 'CLIP',
        phoneNumber,
        typeOfAddress: 145,
        timestamp: new Date().toISOString(),
        isSimulated: true,
      };
      this.emitUrc(clipEvent);

      if (this.ringCount >= maxRings) {
        this.stopRingLoop();
        this.isIncomingRinging = false;
        this.emitUrc({
          raw: 'NO CARRIER',
          type: 'NO_CARRIER',
          timestamp: new Date().toISOString(),
          isSimulated: true,
        });
        this.activeCallRemoteNumber = null;
      }
    };

    emitRing();
    this.ringTimer = setInterval(emitRing, this.options.ringIntervalMs);
  }

  simulateRemoteHangup(): void {
    if (this.activeCallRemoteNumber) {
      this.hangup().catch(() => {});
    }
  }

  simulateSignalFluctuation(newRssi: number): void {
    this.rssi = Math.max(0, Math.min(31, newRssi));
    this.emitUrc({
      raw: `+CSQ: ${this.rssi},99`,
      type: 'SIGNAL_UPDATE',
      payload: { rssi: this.rssi },
      timestamp: new Date().toISOString(),
      isSimulated: true,
    });
  }

  simulatePortDisconnect(): void {
    this.stopRingLoop();
    this.connectionState = 'DISCONNECTED';
    this.emit('connection_state', this.connectionState);
    this.emit('error', new Error('Simulated serial port disconnected'));
  }

  private stopRingLoop(): void {
    if (this.ringTimer) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
  }

  private emitUrc(urc: UrcEvent): void {
    if (urc.type === 'CLIP') {
      this.isIncomingRinging = true;
      this.activeCallRemoteNumber = (urc as ClipUrcEvent).phoneNumber;
    }
    this.emit('urc', urc);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
