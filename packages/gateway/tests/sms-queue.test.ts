import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AtCommandError, AtCommandTimeoutError, UrcEvent } from '@sim-gateway/shared';
import { AtCommandQueue, AtPromptTimeoutError } from '../src/adapters/modem/at-command-queue.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { AtParser } from '../src/adapters/modem/at-parser.js';
import { FakeSerialTransport } from '../src/adapters/modem/serial-transport.js';
import { parseCmgl, parseCmgr } from '../src/sms/parse.js';

const CMGS = 'AT+CMGS="+919876543210"';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AT+CMGS through the serialized AT queue (mocked transport; nothing is sent to a modem)', () => {
  let transport: FakeSerialTransport;
  let queue: AtCommandQueue;
  let writes: string[];
  let urcs: UrcEvent[];

  beforeEach(async () => {
    transport = new FakeSerialTransport('COM14', 115200);
    await transport.open();
    queue = new AtCommandQueue(transport, { defaultTimeoutMs: 300 });
    writes = [];
    urcs = [];
    queue.on('urc', (u: UrcEvent) => urcs.push(u));
  });

  afterEach(() => queue.reset());

  /** A modem that answers the prompt and the body the way a SIM7600 does. */
  const modem = (onBody: (body: string) => void, answerPrompt = true) =>
    transport.onWrite((w) => {
      writes.push(w);
      if (w === `${CMGS}\r` && answerPrompt) setTimeout(() => transport.feedIncomingData('\r\n> '), 5);
      else if (w.endsWith('\x1a')) setTimeout(() => onBody(w.slice(0, -1)), 5);
    });

  it('sends the command with CR only, waits for the prompt, sends the body and Ctrl+Z, and returns the reference', async () => {
    modem(() => transport.feedIncomingData('\r\n+CMGS: 7\r\n\r\nOK\r\n'));
    const response = await queue.executeWithPrompt(CMGS, 'hello there', { promptTimeoutMs: 300, timeoutMs: 500 });
    expect(response).toContain('+CMGS: 7');
    // CR only: a trailing LF would arrive after the prompt and start the message text.
    expect(writes).toEqual([`${CMGS}\r`, 'hello there\x1a']);
  });

  it('recognises a prompt that arrives in pieces, and one that follows echoed text', async () => {
    transport.onWrite((w) => {
      writes.push(w);
      if (w === `${CMGS}\r`) {
        setTimeout(() => transport.feedIncomingData(`${CMGS}\r\n`), 5); // echo (ATE1)
        setTimeout(() => transport.feedIncomingData('\r\n'), 10);
        setTimeout(() => transport.feedIncomingData('>'), 15);
        setTimeout(() => transport.feedIncomingData(' '), 20);
      } else if (w.endsWith('\x1a')) setTimeout(() => transport.feedIncomingData('+CMGS: 3\r\nOK\r\n'), 5);
    });
    expect(await queue.executeWithPrompt(CMGS, 'x', { promptTimeoutMs: 300, timeoutMs: 500 })).toContain('+CMGS: 3');
    expect(writes[1]).toBe('x\x1a');
  });

  it('rejects with the modem\'s +CMS ERROR after the body (Invalid text mode parameter)', async () => {
    modem(() => transport.feedIncomingData('\r\n+CMS ERROR: Invalid text mode parameter\r\n'));
    const error = await queue.executeWithPrompt(CMGS, 'hello', { promptTimeoutMs: 300, timeoutMs: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(AtCommandError);
    expect(error.message).toBe('CMS ERROR: Invalid text mode parameter');
  });

  it('rejects at once, writing no body, when the modem answers the command line with an error instead of a prompt', async () => {
    transport.onWrite((w) => {
      writes.push(w);
      setTimeout(() => transport.feedIncomingData('\r\n+CMS ERROR: SMSC address unknown\r\n'), 5);
    });
    const error = await queue.executeWithPrompt(CMGS, 'hello', { promptTimeoutMs: 300, timeoutMs: 500 }).catch((e) => e);
    expect(error.message).toBe('CMS ERROR: SMSC address unknown');
    expect(writes).toEqual([`${CMGS}\r`]); // no body, no Ctrl+Z
  });

  it('times out waiting for the prompt, writes Escape so the modem leaves text entry, and says nothing was sent', async () => {
    modem(() => {}, false);
    const error = await queue.executeWithPrompt(CMGS, 'hello', { promptTimeoutMs: 60, timeoutMs: 500 }).catch((e) => e);
    expect(error).toBeInstanceOf(AtPromptTimeoutError);
    expect(error).toBeInstanceOf(AtCommandTimeoutError);
    expect(error.phase).toBe('prompt');
    expect(writes).toEqual([`${CMGS}\r`, '\x1b']);
    expect(writes.join('')).not.toContain('hello');
  });

  it('times out after the body was sent with phase "completion" (outcome unknown) and does not write Escape', async () => {
    modem(() => {}); // prompt answered, then silence
    const error = await queue.executeWithPrompt(CMGS, 'hello', { promptTimeoutMs: 100, timeoutMs: 80 }).catch((e) => e);
    expect(error).toBeInstanceOf(AtPromptTimeoutError);
    expect(error.phase).toBe('completion');
    expect(writes).toEqual([`${CMGS}\r`, 'hello\x1a']);
  });

  it('holds every other command until the SMS exchange is finished (one uninterrupted exchange on the port)', async () => {
    transport.onWrite((w) => {
      writes.push(w);
      if (w === `${CMGS}\r`) setTimeout(() => transport.feedIncomingData('\r\n> '), 20);
      else if (w.endsWith('\x1a')) setTimeout(() => transport.feedIncomingData('+CMGS: 5\r\nOK\r\n'), 20);
      else if (w.startsWith('AT+CSQ')) setTimeout(() => transport.feedIncomingData('+CSQ: 20,99\r\nOK\r\n'), 5);
    });
    const sms = queue.executeWithPrompt(CMGS, 'body', { promptTimeoutMs: 300, timeoutMs: 500 });
    const csq = queue.execute('AT+CSQ'); // queued while the SMS is in flight
    await Promise.all([sms, csq]);
    expect(writes).toEqual([`${CMGS}\r`, 'body\x1a', 'AT+CSQ\r\n']);
  });

  it('a late result of a timed-out send does not become the answer to the next command', async () => {
    modem(() => {});
    await queue.executeWithPrompt(CMGS, 'hello', { promptTimeoutMs: 100, timeoutMs: 50 }).catch(() => {});
    transport.onWrite((w) => {
      writes.push(w);
      if (w.startsWith('AT+CSQ')) {
        // the old send finally reports, then the new command answers
        transport.feedIncomingData('+CMGS: 9\r\nOK\r\n');
        setTimeout(() => transport.feedIncomingData('+CSQ: 21,99\r\nOK\r\n'), 5);
      }
    });
    expect(await queue.execute('AT+CSQ')).toBe('+CSQ: 21,99\nOK');
  });

  it('refuses a body that holds Ctrl+Z or Escape, before anything is written', async () => {
    modem(() => {});
    await expect(queue.executeWithPrompt(CMGS, 'a\x1ab')).rejects.toThrow(/Ctrl\+Z or Escape/);
    await expect(queue.executeWithPrompt(CMGS, 'a\x1bb')).rejects.toThrow(/Ctrl\+Z or Escape/);
    expect(writes).toEqual([]);
  });

  it('an ordinary command is unchanged: CR LF, no prompt handling', async () => {
    transport.onWrite((w) => {
      writes.push(w);
      setTimeout(() => transport.feedIncomingData('OK\r\n'), 5);
    });
    await queue.execute('AT');
    expect(writes).toEqual(['AT\r\n']);
  });
});

describe('reading stored messages must not be mistaken for call events', () => {
  let transport: FakeSerialTransport;
  let queue: AtCommandQueue;
  let urcs: UrcEvent[];

  beforeEach(async () => {
    transport = new FakeSerialTransport('COM14', 115200);
    await transport.open();
    queue = new AtCommandQueue(transport, { defaultTimeoutMs: 300 });
    urcs = [];
    queue.on('urc', (u: UrcEvent) => urcs.push(u));
  });
  afterEach(() => queue.reset());

  const reply = (text: string) =>
    transport.onWrite(() => {
      setTimeout(() => transport.feedIncomingData(text), 5);
    });

  it('keeps message text that looks like RING, BUSY, NO CARRIER or OK as text, and emits no call event', async () => {
    reply(
      [
        '+CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"',
        'RING',
        '+CMGL: 2,"REC UNREAD","+919999999999",,"26/10/27,18:05:00+22"',
        'NO CARRIER',
        'BUSY',
        '+CMGL: 3,"REC READ","+918888888888",,"26/10/27,18:06:00+22"',
        'OK',
        'OK',
        '',
      ].join('\r\n')
    );
    const response = await queue.execute('AT+CMGL="ALL",1');
    expect(urcs).toEqual([]);
    const messages = parseCmgl(response);
    expect(messages.map((m) => m.text)).toEqual(['RING', 'NO CARRIER\nBUSY', 'OK']);
  });

  it('reads an empty message text without waiting for a timeout', async () => {
    reply('+CMGR: "REC READ","+911234567890",,"26/10/27,18:00:00+22"\r\n\r\nOK\r\n');
    const response = await queue.execute('AT+CMGR=1,1');
    expect(parseCmgr(response, 1)?.text).toBe('');
  });

  it('still reports a real RING when no message is being read', async () => {
    transport.feedIncomingData('\r\nRING\r\n');
    await wait(10);
    expect(urcs.map((u) => u.type)).toEqual(['RING']);
  });

  it('a +CMS ERROR while reading rejects normally', async () => {
    reply('+CMS ERROR: invalid memory index\r\n');
    await expect(queue.execute('AT+CMGR=999,1')).rejects.toThrow(/invalid memory index/);
  });

  it('does not write message text to the debug log path as a call event, and an empty storage lists nothing', async () => {
    reply('OK\r\n');
    expect(parseCmgl(await queue.execute('AT+CMGL="ALL",1'))).toEqual([]);
    expect(urcs).toEqual([]);
  });
});

describe('new-message indications (+CMTI) are modem events, never message text', () => {
  let transport: FakeSerialTransport;
  let queue: AtCommandQueue;
  let urcs: UrcEvent[];

  beforeEach(async () => {
    transport = new FakeSerialTransport('COM14', 115200);
    await transport.open();
    queue = new AtCommandQueue(transport, { defaultTimeoutMs: 300 });
    urcs = [];
    queue.on('urc', (u: UrcEvent) => urcs.push(u));
  });
  afterEach(() => queue.reset());

  const sms = () => urcs.filter((u) => u.payload?.kind === 'sms-indication').map((u) => u.payload);

  it('parses the indication and nothing that merely resembles it', () => {
    expect(AtParser.parseCmti('+CMTI: "SM",3')).toEqual({ storage: 'SM', index: 3 });
    expect(AtParser.parseCmti('+CMTI: "ME", 12')).toEqual({ storage: 'ME', index: 12 });
    for (const text of ['+CMTI: hello', '+CMTI: "SM",3 and more', 'see +CMTI: "SM",3', '+CMTI: "SM",', 'CMTI "SM",3']) expect(AtParser.parseCmti(text), text).toBeNull();
    expect(AtParser.isUrc('+CMTI: "SM",3')).toBe(true);
    expect(AtParser.parseUrc('+CMTI: "SM",3')).toMatchObject({ type: 'CUSTOM', payload: { kind: 'sms-indication', storage: 'SM', index: 3 } });
  });

  it('is reported when the modem is idle', async () => {
    transport.feedIncomingData('\r\n+CMTI: "SM",3\r\n');
    await wait(10);
    expect(sms()).toEqual([{ kind: 'sms-indication', storage: 'SM', index: 3 }]);
  });

  it('is reported without polluting the answer to a command that is running', async () => {
    transport.onWrite(() => {
      setTimeout(() => transport.feedIncomingData('+CSQ: 20,99\r\n+CMTI: "ME",7\r\nOK\r\n'), 5);
    });
    expect(await queue.execute('AT+CSQ')).toBe('+CSQ: 20,99\nOK');
    expect(sms()).toEqual([{ kind: 'sms-indication', storage: 'ME', index: 7 }]);
  });

  it('is reported when it arrives in the middle of a message listing, and is not part of any message', async () => {
    transport.onWrite(() => {
      setTimeout(
        () =>
          transport.feedIncomingData(
            [
              '+CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"',
              'first message',
              '+CMTI: "ME",2',
              'still the first message',
              '+CMGL: 2,"REC UNREAD","+919999999999",,"26/10/27,18:05:00+22"',
              'second message',
              'OK',
              '',
            ].join('\r\n')
          ),
        5
      );
    });
    const messages = parseCmgl(await queue.execute('AT+CMGL="ALL",1'));
    expect(messages.map((m) => m.text)).toEqual(['first message\nstill the first message', 'second message']);
    expect(sms()).toEqual([{ kind: 'sms-indication', storage: 'ME', index: 2 }]);
  });

  it('message text that only resembles an indication stays text', async () => {
    transport.onWrite(() => {
      setTimeout(
        () => transport.feedIncomingData(['+CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"', '+CMTI: hello world', 'OK', ''].join('\r\n')),
        5
      );
    });
    expect(parseCmgl(await queue.execute('AT+CMGL="ALL",1'))[0].text).toBe('+CMTI: hello world');
    expect(sms()).toEqual([]);
  });
});

describe('the hardware adapter sends SMS over the same queue', () => {
  it('runs a full send against a faked modem, and refuses a destination that could inject commands', async () => {
    const transport = new FakeSerialTransport('COM14', 115200);
    const adapter = new Sim7600HardwareAdapter({ atPort: 'COM14', atBaudRate: 115200, commandTimeoutMs: 500, autoReconnect: false, transport });
    const seen: string[] = [];
    transport.onWrite((w) => {
      seen.push(w);
      if (w.includes('AT+CPIN?')) transport.feedIncomingData('+CPIN: READY\r\nOK\r\n');
      else if (w === `${CMGS}\r`) setTimeout(() => transport.feedIncomingData('\r\n> '), 5);
      else if (w.endsWith('\x1a')) setTimeout(() => transport.feedIncomingData('\r\n+CMGS: 21\r\n\r\nOK\r\n'), 5);
      else if (w.endsWith('\r\n')) transport.feedIncomingData('OK\r\n');
    });
    await adapter.initialize();
    seen.length = 0;

    const result = await adapter.sendSmsText('+919876543210', 'Test message', { promptTimeoutMs: 300, completionTimeoutMs: 500 });
    expect(result).toMatchObject({ messageReference: 21 });
    expect(seen).toEqual([`${CMGS}\r`, 'Test message\x1a']);

    await expect(adapter.sendSmsText('+91"; AT+CFUN=0', 'x')).rejects.toThrow(/Invalid destination/);
    await expect(adapter.sendSmsText('+9198\r\nAT+CFUN=0', 'x')).rejects.toThrow(/Invalid destination/);
    expect(seen).toHaveLength(2); // nothing more was written
    await adapter.close();
  });
});
