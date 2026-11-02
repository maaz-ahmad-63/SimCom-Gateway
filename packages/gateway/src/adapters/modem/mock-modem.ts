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
  SimPinStatus,
  UrcEvent,
  ClipUrcEvent,
  CallEndUrcEvent,
} from '@sim-gateway/shared';

import { AtPromptTimeoutError } from './at-command-queue.js';

/** Simulated SMS storage and settings, so the SMS endpoints can be exercised without a modem. Nothing is ever transmitted. */
export interface MockSmsState {
  /** AT+CMGF: 1 = text mode, 0 = PDU mode. */
  cmgf: number;
  cscs: string;
  /** AT+CSCA number ('' = none set). */
  csca: string;
  /** AT+CSMP value, as the modem prints it. */
  csmp: string;
  messages: Array<{ index: number; status: string; address: string; scts: string; text: string }>;
  /** Messages "sent" through sendSmsText(), in order. */
  sent: Array<{ to: string; text: string }>;
  /** Make the next sendSmsText fail in one of the ways a real modem does. */
  failNextSend: null | { cms: string } | { timeout: 'prompt' | 'completion' } | { error: string };
  /** How AT+CSMP=... behaves: accept it, answer +CMS ERROR, answer ERROR, or say OK without changing anything. */
  csmpWrite: 'accept' | 'reject' | 'error' | 'ignore';
  /** The storage AT+CPMS? reports, its capacity, and AT+CNMI?'s value (its 2nd number 1 = +CMTI indications). */
  storage: string;
  storageTotal: number;
  cnmi: string;
  /** Make the next AT+CMGL fail with this text (for example "CMS ERROR: SIM busy"). */
  failNextList: string | null;
  /** false: answer a bare ERROR to AT+CMGL/AT+CMGR with the ",1" (do not change status) parameter, as some SIM7600 firmware does. */
  listModeSupported: boolean;
  /** What AT+CPMS=? lists for read, write and receive. */
  supportedStorages: { read: string[]; write: string[]; receive: string[] };
  /** The storages not selected now, with their contents and size (the selected one is `storage`, `messages`, `storageTotal`). */
  otherStorages: Record<string, { total: number; messages: MockSmsState['messages'] }>;
  /** Every AT command the mock was asked to run for SMS, in order (to prove what was and was not sent). */
  commands: string[];
}

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
  private lastCommunicationTime: string | null = null;
  private readonly options: Required<MockModemOptions>;
  private smsReference = 0;

  readonly sms: MockSmsState = {
    cmgf: 1,
    cscs: 'GSM',
    csca: '+919800000000',
    csmp: '17,167,0,0',
    messages: [],
    sent: [],
    failNextSend: null,
    csmpWrite: 'accept',
    storage: 'ME',
    storageTotal: 100,
    cnmi: '2,1,0,0,0',
    failNextList: null,
    listModeSupported: true,
    supportedStorages: { read: ['SM', 'ME'], write: ['SM', 'ME'], receive: ['SM', 'ME'] },
    otherStorages: { SM: { total: 30, messages: [] } },
    commands: [],
  };

  /**
   * Test helper: a message arrives the way it does on the modem: it is stored, and (when AT+CNMI says so) a
   * `+CMTI: "<storage>",<index>` indication is announced. Returns the index. If the storage is full the message is
   * not stored and nothing is announced.
   */
  receiveSms(from: string, text: string, scts = '26/10/27,18:00:00+22'): number | null {
    if (this.sms.messages.length >= this.sms.storageTotal) return null;
    const index = this.addIncomingSms(from, text, 'REC UNREAD', scts);
    if (this.sms.cnmi.split(',')[1] === '1') {
      this.emitUrc({
        raw: `+CMTI: "${this.sms.storage}",${index}`,
        type: 'CUSTOM',
        payload: { kind: 'sms-indication', storage: this.sms.storage, index },
        timestamp: new Date().toISOString(),
        isSimulated: true,
      });
    }
    return index;
  }

  /** Test helper: a message arrives in the simulated storage; returns its index. */
  addIncomingSms(from: string, text: string, status = 'REC UNREAD', scts = '26/10/27,18:00:00+22'): number {
    const index = this.sms.messages.reduce((max, m) => Math.max(max, m.index), 0) + 1;
    this.sms.messages.push({ index, status, address: from, scts, text });
    return index;
  }

  /** Simulates AT+CMGS: records the message, or fails the way sms.failNextSend says. Nothing leaves the process. */
  async sendSmsText(
    to: string,
    text: string,
    options: { promptTimeoutMs?: number; completionTimeoutMs?: number } = {}
  ): Promise<{ messageReference: number | null; raw: string }> {
    this.sms.commands.push(`AT+CMGS="${to}"`);
    await this.delay(40);
    const failure = this.sms.failNextSend;
    this.sms.failNextSend = null;
    if (failure) {
      if ('cms' in failure) throw new AtCommandError(`AT+CMGS="${to}"`, '', `CMS ERROR: ${failure.cms}`);
      if ('timeout' in failure) {
        throw new AtPromptTimeoutError(`AT+CMGS="${to}"`, failure.timeout === 'prompt' ? (options.promptTimeoutMs ?? 5000) : (options.completionTimeoutMs ?? 30000), failure.timeout);
      }
      throw new AtCommandError(`AT+CMGS="${to}"`, '', failure.error);
    }
    this.sms.sent.push({ to, text });
    const messageReference = ++this.smsReference;
    return { messageReference, raw: `+CMGS: ${messageReference}\nOK` };
  }

  /** The SMS subset of executeCommand; null when the command is not an SMS command. */
  private executeSmsCommand(command: string): string | null {
    const s = this.sms;
    if (!/^AT\+(CMGF|CSCS|CSCA|CSMP|CPMS|CNMI|CSDH|CMGL|CMGR|CMGD)/.test(command)) return null;
    s.commands.push(command);
    const stored = s.messages.length;
    if (command === 'AT+CMGF?') return `+CMGF: ${s.cmgf}\nOK`;
    if (command === 'AT+CMGF=1' || command === 'AT+CMGF=0') {
      s.cmgf = Number(command.slice(-1));
      return 'OK';
    }
    if (command === 'AT+CSCS?') return `+CSCS: "${s.cscs}"\nOK`;
    if (command === 'AT+CSCA?') return `+CSCA: "${s.csca}",145\nOK`;
    if (command === 'AT+CSMP?') return `+CSMP: ${s.csmp}\nOK`;
    if (command === 'AT+CPMS?') return `+CPMS: "${s.storage}",${stored},${s.storageTotal},"${s.storage}",${stored},${s.storageTotal},"${s.storage}",${stored},${s.storageTotal}\nOK`;
    if (command === 'AT+CNMI?') return `+CNMI: ${s.cnmi}\nOK`;
    if (command === 'AT+CPMS=?') {
      const list = (names: string[]) => `(${names.map((n) => `"${n}"`).join(',')})`;
      return `+CPMS: ${list(s.supportedStorages.read)},${list(s.supportedStorages.write)},${list(s.supportedStorages.receive)}\nOK`;
    }
    const cpmsWrite = /^AT\+CPMS="([A-Z]{2})","([A-Z]{2})","([A-Z]{2})"$/.exec(command);
    if (cpmsWrite) {
      const [, a, b, c] = cpmsWrite;
      if (a !== b || b !== c || !s.supportedStorages.read.includes(a) || !s.supportedStorages.write.includes(a) || !s.supportedStorages.receive.includes(a)) {
        throw new AtCommandError(command, '', 'CMS ERROR: operation not allowed');
      }
      if (a !== s.storage) {
        s.otherStorages[s.storage] = { total: s.storageTotal, messages: s.messages };
        const next = s.otherStorages[a] ?? { total: 0, messages: [] };
        delete s.otherStorages[a];
        s.storage = a;
        s.storageTotal = next.total;
        s.messages = next.messages;
      }
      const used = s.messages.length;
      return `+CPMS: ${used},${s.storageTotal},${used},${s.storageTotal},${used},${s.storageTotal}\nOK`;
    }
    const cmgd = /^AT\+CMGD=(\d+)$/.exec(command);
    if (cmgd) {
      const at = s.messages.findIndex((m) => m.index === Number(cmgd[1]));
      if (at === -1) throw new AtCommandError(command, '', 'CMS ERROR: invalid memory index');
      s.messages.splice(at, 1);
      return 'OK';
    }
    if (command === 'AT+CSDH?') return '+CSDH: 0\nOK';
    if (command === 'AT+CMGL=?') return '+CMGL: ("REC UNREAD","REC READ","STO UNSENT","STO SENT","ALL")\nOK';
    if (command === 'AT+CSMP=?') return 'OK';
    const csmpWrite = /^AT\+CSMP=(\d+),(\d+),(\d+),(\d+)$/.exec(command);
    if (csmpWrite) {
      const mode = s.csmpWrite;
      if (mode === 'reject') throw new AtCommandError(command, '', 'CMS ERROR: invalid text mode parameter');
      if (mode === 'error') throw new AtCommandError(command, '', 'AT ERROR');
      if (mode !== 'ignore') s.csmp = `${csmpWrite[1]},${csmpWrite[2]},${csmpWrite[3]},${csmpWrite[4]}`; // 'ignore': OK, but no change
      return 'OK';
    }
    const list = /^AT\+CMGL="([^"]+)"(,1)?$/.exec(command);
    if (list) {
      if (s.cmgf !== 1) throw new AtCommandError(command, '', 'CMS ERROR: invalid text mode parameter');
      if (s.failNextList) {
        const failure = s.failNextList;
        s.failNextList = null;
        throw new AtCommandError(command, '', failure);
      }
      if (list[2] && !s.listModeSupported) throw new AtCommandError(command, 'ERROR', `AT command '${command}' failed: AT ERROR`);
      const lines: string[] = [];
      for (const m of s.messages.filter((x) => list[1] === 'ALL' || x.status === list[1])) {
        lines.push(`+CMGL: ${m.index},"${m.status}","${m.address}",,"${m.scts}"`, m.text);
        if (!list[2] && m.status === 'REC UNREAD') m.status = 'REC READ'; // the plain command marks it read
      }
      return `${lines.join('\n')}${lines.length ? '\n' : ''}OK`;
    }
    const read = /^AT\+CMGR=(\d+)(,1)?$/.exec(command);
    if (read) {
      if (s.cmgf !== 1) throw new AtCommandError(command, '', 'CMS ERROR: invalid text mode parameter');
      const m = s.messages.find((x) => x.index === Number(read[1]));
      if (!m) throw new AtCommandError(command, '', 'CMS ERROR: invalid memory index');
      const out = `+CMGR: "${m.status}","${m.address}",,"${m.scts}"\n${m.text}\nOK`;
      if (!read[2] && m.status === 'REC UNREAD') m.status = 'REC READ';
      return out;
    }
    return 'OK';
  }

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
    this.lastCommunicationTime = new Date().toISOString();
    this.emit('connection_state', this.connectionState);
  }

  async close(): Promise<void> {
    this.stopRingLoop();
    this.connectionState = 'DISCONNECTED';
    this.emit('connection_state', this.connectionState);
  }

  async executeCommand(command: string, timeoutMs = 5000): Promise<string> {
    this.lastCommunicationTime = new Date().toISOString();
    const trimmed = command.trim();
    await this.delay(40); // Realistic UART propagation latency

    const smsReply = this.executeSmsCommand(trimmed);
    if (smsReply !== null) return smsReply;

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
    if (trimmed === 'AT+CEER') {
      return '+CEER: Normal call clearing (simulated)\nOK';
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

  async getSimStatus(): Promise<SimPinStatus> {
    if (this.connectionState === 'DISCONNECTED') {
      return 'DISCONNECTED';
    }
    return 'READY';
  }

  getLastCommunicationTime(): string | null {
    return this.lastCommunicationTime;
  }

  getAtCommunicationStatus(): AtCommunicationStatus {
    if (this.connectionState === 'DISCONNECTED') {
      return 'DISCONNECTED';
    }
    return 'OK';
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
