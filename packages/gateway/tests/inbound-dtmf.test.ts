import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UrcEvent } from '@sim-gateway/shared';
import { AtCommandQueue } from '../src/adapters/modem/at-command-queue.js';
import { AtParser, DtmfUrcEvent, isDtmfUrc } from '../src/adapters/modem/at-parser.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { CallSessionManager } from '../src/core/call-session-manager.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { redactDiagnosticText } from '../src/core/logger.js';
import { parseCmgl } from '../src/sms/parse.js';

// Inbound DTMF, as far as it can be proven WITHOUT a real call. The "+RXDTMF: <key>" format comes from public reports of SIM7500/7600
// behavior; nothing here shows that this module sends it. These tests prove what the gateway does when such a line arrives, and that the
// diagnostic for lines it does not recognize works. Nothing is sent to a modem.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AtParser.parseDtmf', () => {
  it('accepts exactly one key: 0-9, A-D, * and #, in either case, with any spacing', () => {
    for (const key of ['0', '5', '9', 'A', 'D', '*', '#']) expect(AtParser.parseDtmf(`+RXDTMF: ${key}`)).toBe(key);
    expect(AtParser.parseDtmf('+RXDTMF:7')).toBe('7');
    expect(AtParser.parseDtmf('  +RXDTMF:   c  ')).toBe('C');
  });

  it('rejects every other shape, so a different real format shows up in the diagnostic instead of being guessed at', () => {
    for (const line of ['+RXDTMF:', '+RXDTMF: 12', '+RXDTMF: "5"', '+RXDTMF: E', '+RXDTMF: 5,1', '+DTMF: 5', 'RXDTMF: 5', '+RXDTMF 5', '', 'OK']) {
      expect(AtParser.parseDtmf(line), line).toBeNull();
    }
  });

  it('is a URC, and parses to a typed event that keeps the key out of `raw`', () => {
    expect(AtParser.isUrc('+RXDTMF: 5')).toBe(true);
    expect(AtParser.isUrc('+RXDTMF: nonsense')).toBe(false);
    const urc = AtParser.parseUrc('+RXDTMF: 5')!;
    expect(isDtmfUrc(urc)).toBe(true);
    expect((urc as DtmfUrcEvent).payload.digit).toBe('5');
    expect(urc.type).toBe('CUSTOM');
    expect(urc.raw).toBe('+RXDTMF: [REDACTED]');
    expect(urc.isSimulated).toBe(false);
  });

  it('the guard does not take other CUSTOM events for a key', () => {
    expect(isDtmfUrc(AtParser.parseUrc('ALERTING')!)).toBe(false);
    expect(isDtmfUrc(AtParser.parseUrc('+CMTI: "SM",3')!)).toBe(false);
    expect(isDtmfUrc({ raw: '', type: 'CUSTOM', payload: { kind: 'dtmf' }, timestamp: '', isSimulated: false })).toBe(false);
  });

  it('every other URC parses exactly as before', () => {
    expect(AtParser.parseUrc('RING')?.type).toBe('RING');
    expect(AtParser.parseUrc('+CLIP: "+919876543210",145')?.type).toBe('CLIP');
    expect(AtParser.parseUrc('VOICE CALL: END: 10')?.type).toBe('VOICE_CALL_END');
    expect(AtParser.parseUrc('+CMTI: "SM",3')).toMatchObject({ type: 'CUSTOM', payload: { kind: 'sms-indication' } });
  });
});

describe('redactDiagnosticText', () => {
  it('hides a pressed key and leaves everything else as it was', () => {
    expect(redactDiagnosticText('Modem response line: +RXDTMF: 5')).toBe('Modem response line: +RXDTMF: [REDACTED]');
    expect(redactDiagnosticText('+RXDTMF:#')).toBe('+RXDTMF:[REDACTED]');
    expect(redactDiagnosticText('+CSQ: 24,99')).toBe('+CSQ: 24,99');
  });
});

describe('the AT queue and a +RXDTMF line (mocked transport)', () => {
  let transport: FakeSerialTransport;
  let queue: AtCommandQueue;
  let urcs: UrcEvent[];
  let logs: string[];

  beforeEach(async () => {
    transport = new FakeSerialTransport('COM14', 115200);
    await transport.open();
    queue = new AtCommandQueue(transport, { defaultTimeoutMs: 300 });
    urcs = [];
    queue.on('urc', (u: UrcEvent) => urcs.push(u));
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
    vi.spyOn(console, 'debug').mockImplementation((line: string) => void logs.push(String(line)));
  });

  afterEach(() => {
    queue.reset();
    vi.restoreAllMocks();
  });

  const digits = () => urcs.filter(isDtmfUrc).map((u) => u.payload.digit);

  it('idle: every key arrives as one typed event, in order (before this change the line was dropped without a trace)', async () => {
    transport.feedIncomingData('\r\n+RXDTMF: 5\r\n\r\n+RXDTMF: #\r\n+RXDTMF: *\r\n');
    await wait(10);
    expect(digits()).toEqual(['5', '#', '*']);
  });

  it('a line split across serial reads is still one event', async () => {
    transport.feedIncomingData('\r\n+RXD');
    transport.feedIncomingData('TMF: ');
    transport.feedIncomingData('9\r\n');
    await wait(10);
    expect(digits()).toEqual(['9']);
  });

  it('in flight, command with no expected prefix: the event is delivered and the command answer is NOT contaminated', async () => {
    transport.onWrite((w) => {
      if (w.startsWith('AT+CGMM')) setTimeout(() => transport.feedIncomingData('\r\n+RXDTMF: 5\r\nSIM7600E-H\r\n\r\nOK\r\n'), 5);
    });
    const response = await queue.execute('AT+CGMM', 300);
    expect(response).toBe('SIM7600E-H\nOK'); // before this change: "+RXDTMF: 5\nSIM7600E-H\nOK"
    expect(digits()).toEqual(['5']);
  });

  it('in flight, command with an expected prefix: the event is delivered and the answer is unchanged', async () => {
    transport.onWrite((w) => {
      if (w.startsWith('AT+CSQ')) setTimeout(() => transport.feedIncomingData('\r\n+RXDTMF: 7\r\n+CSQ: 24,99\r\n\r\nOK\r\n'), 5);
    });
    expect(await queue.execute('AT+CSQ', 300)).toBe('+CSQ: 24,99\nOK');
    expect(digits()).toEqual(['7']);
    expect(queue.getUnrecognizedLineStats()).toEqual([]); // it was recognized, so it is not "unrecognized"
  });

  it('during an SMS read: the key is an event, never part of the message text', async () => {
    transport.onWrite((w) => {
      if (w.startsWith('AT+CMGL')) {
        setTimeout(
          () =>
            transport.feedIncomingData(
              ['', '+CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"', 'hello there', '+RXDTMF: 4', 'OK', ''].join('\r\n')
            ),
          5
        );
      }
    });
    const response = await queue.execute('AT+CMGL="ALL",1', 300);
    expect(parseCmgl(response).map((m) => m.text)).toEqual(['hello there']);
    expect(digits()).toEqual(['4']);
  });

  it('a message body that merely mentions the prefix inside other text is still just text', async () => {
    transport.onWrite((w) => {
      if (w.startsWith('AT+CMGL')) {
        setTimeout(
          () => transport.feedIncomingData(['', '+CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"', 'see +RXDTMF: 4 in the manual', 'OK', ''].join('\r\n')),
          5
        );
      }
    });
    const response = await queue.execute('AT+CMGL="ALL",1', 300);
    expect(parseCmgl(response).map((m) => m.text)).toEqual(['see +RXDTMF: 4 in the manual']);
    expect(digits()).toEqual([]);
  });

  it('no key is ever written to a log: the URC is announced with the key redacted, at every log level', async () => {
    transport.feedIncomingData('\r\n+RXDTMF: *\r\n+RXDTMF: #\r\n+RXDTMF: D\r\n');
    transport.onWrite((w) => {
      if (w.startsWith('AT+CGMM')) setTimeout(() => transport.feedIncomingData('\r\n+RXDTMF: #\r\nSIM7600E-H\r\n\r\nOK\r\n'), 5);
    });
    await queue.execute('AT+CGMM', 300);
    const all = logs.join('\n');
    expect(all).toContain('URC received [CUSTOM]: +RXDTMF: [REDACTED]'); // idle or in flight: a recognized URC is announced the same way
    for (const key of ['*', '#', 'D']) expect(all).not.toContain(`+RXDTMF: ${key}`);
    expect(all).not.toMatch(/RXDTMF:\s*[0-9A-D*#]\b/);
  });

  it('other URCs are logged exactly as before (the caller number in a +CLIP line is not touched by this change)', async () => {
    transport.feedIncomingData('\r\nRING\r\n');
    await wait(10);
    expect(urcs.map((u) => u.type)).toEqual(['RING']);
    expect(logs.join('\n')).toContain('URC received [RING]: RING');
  });
});

describe('the unrecognized-line diagnostic', () => {
  let transport: FakeSerialTransport;
  let queue: AtCommandQueue;
  let logs: string[];

  beforeEach(async () => {
    transport = new FakeSerialTransport('COM14', 115200);
    await transport.open();
    queue = new AtCommandQueue(transport, { defaultTimeoutMs: 300 });
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(String(line)));
    vi.spyOn(console, 'debug').mockImplementation((line: string) => void logs.push(String(line)));
  });

  afterEach(() => {
    queue.reset();
    vi.restoreAllMocks();
  });

  const announced = () => logs.filter((l) => l.includes('Unrecognized modem line'));

  it('an unsolicited line nothing understands is announced once, as a shape: digits and quoted text are masked', async () => {
    transport.feedIncomingData('\r\n+CNUM: "+919876543210",129\r\n');
    await wait(10);
    expect(queue.getUnrecognizedLineStats()).toEqual([{ shape: '+CNUM: "…",#', count: 1, where: 'idle' }]);
    expect(announced()).toHaveLength(1);
    expect(announced()[0]).toContain('"+CNUM: "…",#"');
    expect(logs.join('\n')).not.toContain('9198');
  });

  it('a pressed key in a format nobody recognizes is reported by shape only, never by value', async () => {
    transport.feedIncomingData('\r\n+DTMF: 5\r\n+DTMF: 9\r\n');
    await wait(10);
    expect(queue.getUnrecognizedLineStats()).toEqual([{ shape: '+DTMF: #', count: 2, where: 'idle' }]);
    expect(logs.join('\n')).not.toMatch(/\+DTMF: [59]/);
  });

  it('repeats are counted, and announced again only every 50th time', async () => {
    for (let i = 0; i < 120; i++) transport.feedIncomingData('\r\n^MODE: 17\r\n');
    await wait(20);
    expect(queue.getUnrecognizedLineStats()).toEqual([{ shape: '^MODE: #', count: 120, where: 'idle' }]);
    expect(announced()).toHaveLength(3); // the first, the 50th and the 100th
  });

  it('is bounded: at most 64 different shapes are kept, with one note when more arrive', async () => {
    const name = (i: number) => String.fromCharCode(65 + (i % 26)) + String.fromCharCode(65 + Math.floor(i / 26));
    for (let i = 0; i < 100; i++) transport.feedIncomingData(`\r\n+${name(i)}X: 1\r\n`);
    await wait(30);
    expect(queue.getUnrecognizedLineStats()).toHaveLength(64);
    expect(logs.filter((l) => l.includes('more than 64 different shapes'))).toHaveLength(1);
  });

  it('a line dropped for the wrong prefix while a command is in flight is reported too', async () => {
    transport.onWrite((w) => {
      if (w.startsWith('AT+CSQ')) setTimeout(() => transport.feedIncomingData('\r\n+ZZZ: 1\r\n+CSQ: 20,99\r\n\r\nOK\r\n'), 5);
    });
    expect(await queue.execute('AT+CSQ', 300)).toBe('+CSQ: 20,99\nOK');
    expect(queue.getUnrecognizedLineStats()).toEqual([{ shape: '+ZZZ: #', count: 1, where: 'during-command' }]);
  });

  it('lines the queue understands, and blank lines, are never reported', async () => {
    transport.feedIncomingData('\r\n\r\nRING\r\n+CLIP: "+911234567890",145\r\nNO CARRIER\r\n+CMTI: "SM",3\r\n+RXDTMF: 5\r\n');
    await wait(10);
    expect(queue.getUnrecognizedLineStats()).toEqual([]);
    expect(announced()).toHaveLength(0);
  });

  it('a normal command exchange is unaffected and reports nothing', async () => {
    transport.onWrite((w) => {
      if (w.startsWith('AT+CSQ')) setTimeout(() => transport.feedIncomingData('\r\n+CSQ: 20,99\r\n\r\nOK\r\n'), 5);
    });
    expect(await queue.execute('AT+CSQ', 300)).toBe('+CSQ: 20,99\nOK');
    expect(queue.getUnrecognizedLineStats()).toEqual([]);
  });
});

describe('a DTMF event reaching the call manager', () => {
  const harness = () => {
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 100 });
    const audio = new MockAudioAdapter();
    const eventBus = new GatewayEventBus();
    const manager = new CallSessionManager({ modem, audio, eventBus });
    return { modem, audio, eventBus, manager };
  };

  it('the broadcast bus never carries the key, the modem-level event still does, and the call is untouched', async () => {
    const { modem, eventBus, manager } = harness();
    await modem.initialize();
    await manager.dial({ phoneNumber: '+919876543210' });
    modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: true });
    expect(manager.getCurrentCall()?.state).toBe('ACTIVE');

    const onBus: UrcEvent[] = [];
    eventBus.on('modem:urc', (u: UrcEvent) => onBus.push(u));
    const changes: string[] = [];
    manager.on('call:state_changed', (e: { currentState: string }) => changes.push(e.currentState));
    const dtmf = AtParser.parseUrc('+RXDTMF: 5')!;
    modem.emit('urc', dtmf);

    expect(onBus).toHaveLength(1);
    expect(onBus[0].payload).toEqual({ kind: 'dtmf' }); // no digit
    expect(JSON.stringify(onBus[0])).not.toContain('"digit"');
    expect((dtmf as DtmfUrcEvent).payload.digit).toBe('5'); // the event modem listeners got is untouched
    expect(changes).toEqual([]);
    expect(manager.getCurrentCall()?.state).toBe('ACTIVE');
    await manager.hangup('done');
    await modem.close();
  });

  it('other URCs still reach the bus unchanged', async () => {
    const { modem, eventBus } = harness();
    const onBus: UrcEvent[] = [];
    eventBus.on('modem:urc', (u: UrcEvent) => onBus.push(u));
    const sms = AtParser.parseUrc('+CMTI: "SM",3')!;
    modem.emit('urc', sms);
    expect(onBus).toEqual([sms]);
    expect(onBus[0]).toBe(sms);
  });
});
