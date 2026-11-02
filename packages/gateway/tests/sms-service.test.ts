import { describe, expect, it } from 'vitest';
import { AtCommandError, AtCommandTimeoutError, ICallSessionManager, IModemAdapter, ModemConnectionState, SerialPortDisconnectedError } from '@sim-gateway/shared';
import { AtPromptTimeoutError } from '../src/adapters/modem/at-command-queue.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { CSMP_CONFIRMATION, SmsCapableModem, SmsError, SmsService } from '../src/sms/sms-service.js';

type Reply = string | Error | (() => string);

const HEALTHY: Record<string, Reply> = {
  'AT+CMGF?': '+CMGF: 1\nOK',
  'AT+CSCS?': '+CSCS: "GSM"\nOK',
  'AT+CSCA?': '+CSCA: "+919800000000",145\nOK',
  'AT+CSMP?': '+CSMP: 17,167,0,0\nOK',
  'AT+CPMS?': '+CPMS: "ME",2,100,"ME",2,100,"ME",2,100\nOK',
  'AT+CNMI?': '+CNMI: 2,1,0,0,0\nOK',
  'AT+CSDH?': '+CSDH: 0\nOK',
  'AT+CMGL=?': '+CMGL: ("REC UNREAD","REC READ","STO UNSENT","STO SENT","ALL")\nOK',
  'AT+CSMP=?': 'OK',
  'AT+CMGF=1': 'OK',
};

function rig(overrides: Record<string, Reply> = {}) {
  const state = { connection: 'READY' as ModemConnectionState, call: null as unknown, commands: [] as string[], sends: [] as Array<{ to: string; text: string }> };
  const replies: Record<string, Reply> = { ...HEALTHY, ...overrides };
  let sendBehaviour: () => Promise<{ messageReference: number | null; raw: string }> = async () => ({ messageReference: 11, raw: '+CMGS: 11\nOK' });
  const modem = {
    driverType: 'hardware',
    isSimulated: false,
    getConnectionState: () => state.connection,
    executeCommand: async (command: string) => {
      state.commands.push(command);
      const reply = replies[command] ?? 'OK';
      const value = typeof reply === 'function' ? reply() : reply;
      if (value instanceof Error) throw value;
      return value;
    },
    sendSmsText: async (to: string, text: string) => {
      state.sends.push({ to, text });
      return sendBehaviour();
    },
  } as unknown as IModemAdapter & SmsCapableModem;
  const callManager = { getCurrentCall: () => state.call } as unknown as ICallSessionManager;
  const service = new SmsService({ modem, callManager });
  return {
    service,
    state,
    replies,
    onSend: (fn: typeof sendBehaviour) => void (sendBehaviour = fn),
    // Commands that WRITE a modem setting (reads, test commands "=?" and the list/read commands are not writes).
    writes: () => state.commands.filter((c) => /^AT\+(CMGF|CSCA|CSMP|CSCS|CPMS|CNMI|CSDH|CMGD|CFUN|CMEE)=[^?]/.test(c)),
  };
}

const catchError = async (p: Promise<unknown>): Promise<SmsError> => {
  try {
    await p;
  } catch (error) {
    return error as SmsError;
  }
  throw new Error('expected the promise to reject');
};

describe('sending', () => {
  it('sends, reports the reference, and only reads the modem settings (no writes, no retry)', async () => {
    const r = rig();
    const result = await r.service.send('+919876543210', 'Your order is ready.');
    expect(result).toMatchObject({ success: true, to: '+919876543210', messageReference: 11, characters: 20, settingsChanged: [], warnings: [], isSimulated: false });
    expect(r.state.sends).toEqual([{ to: '+919876543210', text: 'Your order is ready.' }]);
    expect(r.state.commands).toEqual(['AT+CMGF?', 'AT+CSCS?', 'AT+CSCA?', 'AT+CSMP?']);
    expect(r.writes()).toEqual([]);
  });

  it('switches a modem in PDU mode to text mode, says so, and changes nothing else', async () => {
    const r = rig({ 'AT+CMGF?': '+CMGF: 0\nOK' });
    const result = await r.service.send('+919876543210', 'Hello');
    expect(result.settingsChanged).toEqual(['AT+CMGF=1 (the modem was in PDU mode)']);
    expect(r.writes()).toEqual(['AT+CMGF=1']); // never CSCA, CSMP, CSCS, CPMS or CNMI
  });

  it('a rejected text-mode parameter (+CMS ERROR: Invalid text mode parameter) is diagnosed, not retried', async () => {
    const r = rig();
    r.onSend(async () => {
      throw new AtCommandError('AT+CMGS="+919876543210"', '', 'CMS ERROR: Invalid text mode parameter');
    });
    const error = await catchError(r.service.send('+919876543210', 'Hello'));
    expect(error).toMatchObject({ status: 502, code: 'SMS_CMS_ERROR' });
    expect(error.message).toMatch(/305 \(invalid text mode parameter\)/i);
    expect(error.details).toMatchObject({ cmsCode: 305, snapshot: { charset: 'GSM', smsc: '(set)', csmp: { fo: 17, vp: 167, pid: 0, dcs: 0 } } });
    expect(String(error.details?.hint)).toMatch(/AT\+CSMP/);
    expect(r.state.sends).toHaveLength(1); // exactly one attempt
    expect(r.writes()).toEqual([]); // and no setting was touched
  });

  it('refuses before sending when the modem\'s own parameters would make it reject the message', async () => {
    const r = rig({ 'AT+CSMP?': '+CSMP: 16,167,0,12\nOK' });
    const error = await catchError(r.service.send('+919876543210', 'Hello'));
    expect(error).toMatchObject({ status: 409, code: 'SMS_PARAMS_INVALID' });
    expect(error.details?.problems).toEqual(expect.arrayContaining([expect.stringMatching(/not an SMS-SUBMIT/), expect.stringMatching(/reserved alphabet/)]));
    expect(r.state.sends).toHaveLength(0);
    expect(r.writes()).toEqual([]);
  });

  it('does not invent an SMSC: an empty service-centre number stops the send', async () => {
    const r = rig({ 'AT+CSCA?': '+CSCA: "",145\nOK' });
    const error = await catchError(r.service.send('+919876543210', 'Hello'));
    expect(error).toMatchObject({ status: 409, code: 'SMSC_NOT_SET' });
    expect(r.state.sends).toHaveLength(0);
    expect(r.writes()).toEqual([]);
  });

  it('a settings query that cannot be answered is a warning, not a reason to refuse', async () => {
    const r = rig({ 'AT+CSCA?': new AtCommandTimeoutError('AT+CSCA?', 5000) });
    const result = await r.service.send('+919876543210', 'Hello');
    expect(result.warnings[0]).toMatch(/AT\+CSCA\? could not be read/);
    expect(r.state.sends).toHaveLength(1);
  });

  it('checks the text against the modem charset and refuses what it cannot carry faithfully', async () => {
    const gsm = rig();
    expect((await catchError(gsm.service.send('+919876543210', 'mail me at a@b.com'))).code).toBe('UNSUPPORTED_CHARACTERS');
    expect((await catchError(gsm.service.send('+919876543210', 'a'.repeat(161)))).code).toBe('MESSAGE_TOO_LONG');
    expect(gsm.state.sends).toHaveLength(0);

    const ira = rig({ 'AT+CSCS?': '+CSCS: "IRA"\nOK' });
    await ira.service.send('+919876543210', 'mail me at a@b.com');
    expect(ira.state.sends).toHaveLength(1);

    const ucs2 = rig({ 'AT+CSCS?': '+CSCS: "UCS2"\nOK' });
    const error = await catchError(ucs2.service.send('+919876543210', 'Hello'));
    expect(error).toMatchObject({ status: 409, code: 'UNSUPPORTED_CHARSET' });
    expect(ucs2.writes()).toEqual([]);
  });

  it('validates the request before touching the modem', async () => {
    const r = rig();
    for (const [to, message, code] of [
      ['9876543210', 'hi', 'INVALID_DESTINATION'],
      ['+919876543210;AT+CFUN=0', 'hi', 'INVALID_DESTINATION'],
      ['+919876543210', '', 'INVALID_MESSAGE'],
      ['+919876543210', 'bad\x1atext', 'INVALID_MESSAGE'],
      ['+919876543210', 42, 'INVALID_MESSAGE'],
    ] as const) {
      const error = await catchError(r.service.send(to, message));
      expect(error, `${to} ${String(message)}`).toMatchObject({ status: 400, code });
    }
    expect(r.state.commands).toEqual([]);
  });
});

describe('failures and timeouts', () => {
  it('no prompt: reports that nothing was sent', async () => {
    const r = rig();
    r.onSend(async () => {
      throw new AtPromptTimeoutError('AT+CMGS', 8000, 'prompt');
    });
    const error = await catchError(r.service.send('+919876543210', 'Hello'));
    expect(error).toMatchObject({ status: 504, code: 'SMS_PROMPT_TIMEOUT' });
    expect(error.message).toMatch(/Nothing was sent/);
    expect(r.state.sends).toHaveLength(1);
  });

  it('no result after the text was sent: the outcome is unknown and the caller is told not to retry blindly', async () => {
    const r = rig();
    r.onSend(async () => {
      throw new AtPromptTimeoutError('AT+CMGS', 30000, 'completion');
    });
    const error = await catchError(r.service.send('+919876543210', 'Hello'));
    expect(error).toMatchObject({ status: 504, code: 'SMS_OUTCOME_UNKNOWN' });
    expect(error.message).toMatch(/MAY have been sent/);
    expect(error.message).toMatch(/before sending again/);
    expect(r.state.sends).toHaveLength(1); // not retried
  });

  it('maps a timed-out settings query, a dropped port and other modem errors', async () => {
    const timeout = rig({ 'AT+CMGF?': new AtCommandTimeoutError('AT+CMGF?', 5000) });
    expect(await catchError(timeout.service.send('+919876543210', 'Hello'))).toMatchObject({ status: 504, code: 'MODEM_TIMEOUT' });
    expect(timeout.state.sends).toHaveLength(0);

    const dropped = rig();
    dropped.onSend(async () => {
      throw new SerialPortDisconnectedError('COM14', 'port closed');
    });
    expect(await catchError(dropped.service.send('+919876543210', 'Hello'))).toMatchObject({ status: 503, code: 'MODEM_DISCONNECTED' });

    const other = rig();
    other.onSend(async () => {
      throw new AtCommandError('AT+CMGS', '', 'CME ERROR: SIM not inserted');
    });
    expect(await catchError(other.service.send('+919876543210', 'Hello'))).toMatchObject({ status: 502, code: 'MODEM_ERROR' });
  });

  it('gives a hint for each common +CMS ERROR', async () => {
    for (const [text, code, hint] of [
      ['SMSC address unknown', 330, /not set automatically/],
      ['no network service', 331, /signal and registration/],
      ['SIM PIN required', 311, /PIN/],
    ] as const) {
      const r = rig();
      r.onSend(async () => {
        throw new AtCommandError('AT+CMGS', '', `CMS ERROR: ${text}`);
      });
      const error = await catchError(r.service.send('+919876543210', 'Hello'));
      expect(error.details).toMatchObject({ cmsCode: code });
      expect(String(error.details?.hint)).toMatch(hint);
    }
  });
});

describe('protecting calls and concurrent operations', () => {
  it('refuses during a call without sending any AT command', async () => {
    const r = rig();
    r.state.call = { id: 'c1', state: 'ACTIVE' };
    for (const run of [() => r.service.send('+919876543210', 'Hello'), () => r.service.list(), () => r.service.read(1), () => r.service.status()]) {
      expect(await catchError(run())).toMatchObject({ status: 409, code: 'CALL_IN_PROGRESS' });
    }
    expect(r.state.commands).toEqual([]);
    expect(r.state.sends).toHaveLength(0);
  });

  it('refuses a send if a call starts while the settings are being read', async () => {
    const r = rig();
    r.replies['AT+CSMP?'] = () => {
      r.state.call = { id: 'c2', state: 'INBOUND_RINGING' };
      return '+CSMP: 17,167,0,0\nOK';
    };
    expect(await catchError(r.service.send('+919876543210', 'Hello'))).toMatchObject({ status: 409, code: 'CALL_IN_PROGRESS' });
    expect(r.state.sends).toHaveLength(0);
  });

  it('refuses while the modem is not READY', async () => {
    const r = rig();
    r.state.connection = 'INITIALIZING';
    expect(await catchError(r.service.send('+919876543210', 'Hello'))).toMatchObject({ status: 409, code: 'MODEM_NOT_READY' });
    expect(r.state.commands).toEqual([]);
  });

  it('allows one SMS operation at a time: a second request is refused as busy, then the service is free again', async () => {
    const r = rig();
    let release: () => void = () => {};
    r.onSend(() => new Promise((resolve) => (release = () => resolve({ messageReference: 1, raw: '+CMGS: 1\nOK' }))));
    const first = r.service.send('+919876543210', 'first');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(r.service.busy).toBe('send');
    expect(await catchError(r.service.send('+919876543210', 'second'))).toMatchObject({ status: 409, code: 'SMS_BUSY' });
    expect(await catchError(r.service.list())).toMatchObject({ code: 'SMS_BUSY' });
    release();
    await first;
    expect(r.service.busy).toBeNull();
    r.onSend(async () => ({ messageReference: 2, raw: '+CMGS: 2\nOK' }));
    expect((await r.service.send('+919876543210', 'third')).messageReference).toBe(2);
    expect(r.state.sends.map((s) => s.text)).toEqual(['first', 'third']);
  });

  it('frees the service after a failure too', async () => {
    const r = rig();
    r.onSend(async () => {
      throw new AtPromptTimeoutError('AT+CMGS', 30000, 'completion');
    });
    await catchError(r.service.send('+919876543210', 'Hello'));
    expect(r.service.busy).toBeNull();
  });
});

describe('listing and reading stored messages', () => {
  const listing = [
    '+CMGL: 1,"REC READ","+911234567890",,"26/10/27,18:00:00+22"',
    'Meeting at 5',
    '+CMGL: 2,"REC UNREAD","+919999999999",,"26/10/27,18:05:00+22"',
    'RING',
    'OK',
  ].join('\n');

  it('lists incoming messages without changing their status, and reports the storage', async () => {
    const r = rig({ 'AT+CMGL="ALL",1': listing });
    const result = await r.service.list();
    expect(result).toMatchObject({ success: true, count: 2, markedRead: false, settingsChanged: [], storage: { name: 'ME', used: 2, total: 100 } });
    expect(result.messages[1]).toMatchObject({ index: 2, status: 'REC UNREAD', direction: 'received', address: '+919999999999', text: 'RING' });
    expect(r.state.commands).toContain('AT+CMGL="ALL",1');
    expect(r.writes()).toEqual([]);
  });

  it('filters by status and lets the caller opt in to marking messages read', async () => {
    const r = rig({ 'AT+CMGL="REC UNREAD",1': 'OK', 'AT+CMGL="ALL"': listing });
    expect((await r.service.list({ status: 'unread' })).count).toBe(0);
    expect((await r.service.list({ status: 'all', markRead: true })).markedRead).toBe(true);
    expect(r.state.commands).toEqual(expect.arrayContaining(['AT+CMGL="REC UNREAD",1', 'AT+CMGL="ALL"']));
    expect(await catchError(r.service.list({ status: 'bogus' }))).toMatchObject({ status: 400, code: 'INVALID_STATUS' });
  });

  it('switches PDU mode to text mode for a listing and says so', async () => {
    const r = rig({ 'AT+CMGF?': '+CMGF: 0\nOK', 'AT+CMGL="ALL",1': 'OK' });
    expect((await r.service.list()).settingsChanged).toEqual(['AT+CMGF=1 (the modem was in PDU mode)']);
  });

  it('explains a rejected list and points at the plain command, without retrying it', async () => {
    const r = rig({ 'AT+CMGL="ALL",1': new AtCommandError('AT+CMGL="ALL",1', '', 'CMS ERROR: invalid text mode parameter') });
    const error = await catchError(r.service.list());
    expect(error).toMatchObject({ status: 502, code: 'SMS_CMS_ERROR' });
    expect(String(error.details?.markReadHint)).toMatch(/markRead=true/);
    expect(r.state.commands.filter((c) => c.startsWith('AT+CMGL="ALL"'))).toEqual(['AT+CMGL="ALL",1']); // asked once
  });

  it('reads one message by index, and reports a missing one as 404', async () => {
    const r = rig({
      'AT+CMGR=3,1': '+CMGR: "REC READ","+911234567890",,"26/10/27,18:00:00+22"\nSee you at 5\nOK',
      'AT+CMGR=9,1': new AtCommandError('AT+CMGR=9,1', '', 'CMS ERROR: invalid memory index'),
      'AT+CMGR=8,1': 'OK',
    });
    const found = await r.service.read('3');
    expect(found.message).toMatchObject({ index: 3, text: 'See you at 5', address: '+911234567890', timestamp: '2026-10-27T18:00:00+05:30' });
    expect(await catchError(r.service.read(9))).toMatchObject({ status: 404, code: 'SMS_NOT_FOUND' });
    expect(await catchError(r.service.read(8))).toMatchObject({ status: 404, code: 'SMS_NOT_FOUND' });
    for (const bad of [0, 1000, 'abc', 1.5, -1, undefined]) {
      expect(await catchError(r.service.read(bad)), String(bad)).toMatchObject({ status: 400, code: 'INVALID_INDEX' });
    }
  });
});

describe('read-only configuration check', () => {
  it('reports the settings and whether a send would be accepted, writing nothing', async () => {
    const r = rig();
    const status = (await r.service.status()) as any;
    expect(status.settings).toMatchObject({ textMode: true, serviceCentre: 'set', charset: 'GSM', textModeParameters: { fo: 17, vp: 167, pid: 0, dcs: 0 }, newMessageIndication: [2, 1, 0, 0, 0] });
    expect(status.assessment).toEqual({ canSend: true, problems: [], warnings: [] });
    expect(Object.keys(status.raw)).toEqual(expect.arrayContaining(['textMode', 'serviceCentre', 'textModeParameters', 'charset', 'storage', 'supportedListStatuses']));
    expect(r.writes()).toEqual([]);
  });

  it('shows what would make a send fail, and survives queries the firmware does not answer', async () => {
    const r = rig({ 'AT+CSMP?': '+CSMP: 16,167,0,0\nOK', 'AT+CSCA?': '+CSCA: "",145\nOK', 'AT+CNMI?': new AtCommandError('AT+CNMI?', '', 'ERROR') });
    const status = (await r.service.status()) as any;
    expect(status.assessment.canSend).toBe(false);
    expect(status.assessment.problems).toEqual(expect.arrayContaining([expect.stringMatching(/No SMS service centre/), expect.stringMatching(/not an SMS-SUBMIT/)]));
    expect(status.raw.newMessageIndication.ok).toBe(false);
    expect(r.writes()).toEqual([]);
  });
});

describe('applying the standard text-mode parameters (AT+CSMP=17,167,0,0)', () => {
  const OLD = '+CSMP: 17,11,0,246\nOK'; // the values found on the real modem
  const CONFIRM = CSMP_CONFIRMATION;

  /** A modem whose AT+CSMP? reflects what was last written, like a real one. */
  const csmpRig = (writeBehaviour: 'accept' | 'ignore' | Error = 'accept', readAfter?: Reply) => {
    let current = OLD;
    let writes = 0;
    const r = rig({
      'AT+CSMP?': () => {
        if (writes > 0 && readAfter !== undefined) {
          if (readAfter instanceof Error) throw readAfter;
          return typeof readAfter === 'function' ? readAfter() : readAfter;
        }
        return current;
      },
      'AT+CSMP=17,167,0,0': () => {
        writes++;
        if (writeBehaviour instanceof Error) throw writeBehaviour;
        if (writeBehaviour === 'accept') current = '+CSMP: 17,167,0,0\nOK';
        return 'OK';
      },
    });
    return r;
  };

  it('requires the exact confirmation text and touches nothing without it', async () => {
    const r = csmpRig();
    for (const bad of [undefined, '', 'yes', 'apply at+csmp=17,167,0,0', 'APPLY AT+CSMP=17,167,0,0 ', true, 1]) {
      const error = await catchError(r.service.applyStandardTextParameters(bad));
      expect(error, String(bad)).toMatchObject({ status: 400, code: 'CONFIRMATION_REQUIRED' });
      expect(error.details).toMatchObject({ required: 'APPLY AT+CSMP=17,167,0,0' });
    }
    expect(r.state.commands).toEqual([]);
  });

  it('reads the old value, writes only AT+CSMP=17,167,0,0, reads it back, verifies, and reports old and new', async () => {
    const r = csmpRig();
    const result = await r.service.applyStandardTextParameters(CONFIRM);
    expect(result).toMatchObject({
      success: true,
      changed: true,
      verified: true,
      command: 'AT+CSMP=17,167,0,0',
      old: { fo: 17, vp: 11, pid: 0, dcs: 246 },
      new: { fo: 17, vp: 167, pid: 0, dcs: 0 },
      persisted: false,
    });
    expect(r.state.commands).toEqual(['AT+CSMP?', 'AT+CSMP=17,167,0,0', 'AT+CSMP?']);
    expect(r.writes()).toEqual(['AT+CSMP=17,167,0,0']); // never the service centre, charset, storage or indication
  });

  it('writes nothing when the values are already standard', async () => {
    const r = rig({ 'AT+CSMP?': '+CSMP: 17,167,0,0\nOK' });
    const result = await r.service.applyStandardTextParameters(CONFIRM);
    expect(result).toMatchObject({ success: true, changed: false, verified: true, command: null });
    expect(r.state.commands).toEqual(['AT+CSMP?']);
  });

  it('afterwards, a send passes the pre-check that the old values failed', async () => {
    const r = csmpRig();
    expect((await catchError(r.service.send('+919876543210', 'Hello'))).code).toBe('SMS_PARAMS_INVALID'); // dcs 246
    expect(r.state.sends).toHaveLength(0);
    await r.service.applyStandardTextParameters(CONFIRM);
    expect((await r.service.send('+919876543210', 'Hello')).success).toBe(true);
  });

  it('refuses during a call, while the modem is not READY, and while another SMS operation runs, without any AT command', async () => {
    const call = csmpRig();
    call.state.call = { id: 'c1', state: 'ACTIVE' };
    expect(await catchError(call.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ status: 409, code: 'CALL_IN_PROGRESS' });
    expect(call.state.commands).toEqual([]);

    const down = csmpRig();
    down.state.connection = 'INITIALIZING';
    expect(await catchError(down.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ status: 409, code: 'MODEM_NOT_READY' });
    expect(down.state.commands).toEqual([]);

    const busy = rig(); // healthy settings, so the send really reaches the modem and holds the lock
    let release: () => void = () => {};
    busy.onSend(() => new Promise((resolve) => (release = () => resolve({ messageReference: 1, raw: '+CMGS: 1\nOK' }))));
    const sending = busy.service.send('+919876543210', 'Hello');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const before = busy.state.commands.length;
    expect(await catchError(busy.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ status: 409, code: 'SMS_BUSY' });
    expect(busy.state.commands.length).toBe(before); // nothing was sent to the modem for it
    release();
    await sending;
  });

  it('refuses if a call starts between reading the old value and writing', async () => {
    const r = csmpRig();
    const original = r.replies['AT+CSMP?'];
    r.replies['AT+CSMP?'] = () => {
      r.state.call = { id: 'c2', state: 'INBOUND_RINGING' };
      return typeof original === 'function' ? original() : String(original);
    };
    expect(await catchError(r.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ status: 409, code: 'CALL_IN_PROGRESS' });
    expect(r.writes()).toEqual([]);
  });

  it('reports a rejected write with the old value, does not retry, and does not claim success', async () => {
    const r = csmpRig(new AtCommandError('AT+CSMP=17,167,0,0', '', 'CMS ERROR: invalid text mode parameter'));
    const error = await catchError(r.service.applyStandardTextParameters(CONFIRM));
    expect(error).toMatchObject({ status: 502, code: 'SMS_CMS_ERROR' });
    expect(error.details).toMatchObject({ old: { dcs: 246 }, command: 'AT+CSMP=17,167,0,0' });
    expect(r.state.commands.filter((c) => c.startsWith('AT+CSMP=17'))).toHaveLength(1);
    expect(r.state.commands).toEqual(['AT+CSMP?', 'AT+CSMP=17,167,0,0']); // no read-back after a refusal, no second write
    expect(r.service.busy).toBeNull();
  });

  it('maps a timed-out or generic-error write', async () => {
    const timeout = csmpRig(new AtCommandTimeoutError('AT+CSMP=17,167,0,0', 5000));
    expect(await catchError(timeout.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ status: 504, code: 'MODEM_TIMEOUT' });
    const generic = csmpRig(new AtCommandError('AT+CSMP=17,167,0,0', '', 'AT ERROR'));
    expect(await catchError(generic.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ status: 502, code: 'MODEM_ERROR' });
  });

  it('catches a modem that says OK but did not change the setting (read-back verification)', async () => {
    const r = csmpRig('ignore');
    const error = await catchError(r.service.applyStandardTextParameters(CONFIRM));
    expect(error).toMatchObject({ status: 502, code: 'CSMP_VERIFY_FAILED' });
    expect(error.details).toMatchObject({ old: { dcs: 246 }, requested: { fo: 17, vp: 167, pid: 0, dcs: 0 }, actual: { fo: 17, vp: 11, pid: 0, dcs: 246 } });
    expect(r.state.commands).toEqual(['AT+CSMP?', 'AT+CSMP=17,167,0,0', 'AT+CSMP?']); // never retried
  });

  it('catches a read-back that shows different values, and one that cannot be read at all', async () => {
    const different = csmpRig('accept', '+CSMP: 17,167,0,8\nOK');
    expect(await catchError(different.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ code: 'CSMP_VERIFY_FAILED', details: { actual: { dcs: 8 } } });

    const unreadable = csmpRig('accept', new AtCommandTimeoutError('AT+CSMP?', 5000));
    const error = await catchError(unreadable.service.applyStandardTextParameters(CONFIRM));
    expect(error).toMatchObject({ status: 502, code: 'CSMP_READBACK_FAILED' });
    expect(error.message).toMatch(/current value is unknown/);
  });

  it('cannot proceed without knowing the old value', async () => {
    const r = rig({ 'AT+CSMP?': new AtCommandTimeoutError('AT+CSMP?', 5000) });
    expect(await catchError(r.service.applyStandardTextParameters(CONFIRM))).toMatchObject({ status: 504, code: 'MODEM_TIMEOUT' });
    expect(r.writes()).toEqual([]);
  });
});

describe('with the mock modem driver', () => {
  it('sends, fails and lists through the same service, and nothing is transmitted', async () => {
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    const service = new SmsService({ modem, callManager: { getCurrentCall: () => null } as unknown as ICallSessionManager });

    expect((await service.send('+919876543210', 'Test message')).isSimulated).toBe(true);
    expect(modem.sms.sent).toEqual([{ to: '+919876543210', text: 'Test message' }]);

    modem.sms.failNextSend = { cms: 'Invalid text mode parameter' };
    expect(await catchError(service.send('+919876543210', 'Again'))).toMatchObject({ code: 'SMS_CMS_ERROR' });
    expect(modem.sms.sent).toHaveLength(1);

    modem.sms.failNextSend = { timeout: 'completion' };
    expect(await catchError(service.send('+919876543210', 'Again'))).toMatchObject({ code: 'SMS_OUTCOME_UNKNOWN' });

    modem.addIncomingSms('+911234567890', 'hello from outside');
    const list = await service.list();
    expect(list.messages).toMatchObject([{ index: 1, status: 'REC UNREAD', text: 'hello from outside' }]);
    await modem.close();
  });
});
