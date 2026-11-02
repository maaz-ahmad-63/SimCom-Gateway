import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICallSessionManager, UrcEvent } from '@sim-gateway/shared';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { runMigrations } from '../src/db/migrations.js';
import { SmsInbox, SmsInboxOptions } from '../src/sms/sms-inbox.js';
import { SmsError, SmsService } from '../src/sms/sms-service.js';
import { SmsStore } from '../src/sms/sms-store.js';

const opened: Array<() => void> = [];
afterEach(() => {
  for (const fn of opened.splice(0)) fn();
});

async function rig(options: Partial<SmsInboxOptions> = {}, dbOverride?: InstanceType<typeof Database>) {
  const db = dbOverride ?? new Database(':memory:');
  if (!dbOverride) runMigrations(db);
  const store = new SmsStore(db);
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  await modem.initialize();
  const state = { call: null as unknown };
  const callManager = { getCurrentCall: () => state.call } as unknown as ICallSessionManager;
  const eventBus = new GatewayEventBus();
  const alerts: Array<{ level: string; message: string }> = [];
  eventBus.on('gateway:alert', (alert) => void alerts.push(alert));
  const service = new SmsService({ modem, callManager, store, commandTimeoutMs: 500 });
  const inbox = new SmsInbox({
    service,
    store,
    modem,
    eventBus,
    debounceMs: 10,
    afterCallMs: 10,
    retryDelaysMs: [20, 40, 80],
    waitRecheckMs: 60,
    busyRecheckMs: 10,
    ...options,
  });
  opened.push(() => inbox.stop());
  const idle = () => vi.waitFor(() => expect(inbox.state()).toMatchObject({ syncing: false, pending: false }), { timeout: 3000 });
  const cmgl = () => modem.sms.commands.filter((c) => c.startsWith('AT+CMGL="'));
  return { db, store, modem, state, eventBus, alerts, service, inbox, idle, cmgl };
}

const cmti = (storage: string, index: number): UrcEvent => ({
  raw: `+CMTI: "${storage}",${index}`,
  type: 'CUSTOM',
  payload: { kind: 'sms-indication', storage, index },
  timestamp: new Date().toISOString(),
  isSimulated: true,
});

describe('incoming messages (+CMTI)', () => {
  it('reads a new message when the modem announces it, stores it, and leaves it unread on the modem', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    r.modem.receiveSms('+911234567890', 'Hello there');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1));

    expect(r.store.list().messages[0]).toMatchObject({ direction: 'received', source: 'modem', address: '+911234567890', text: 'Hello there', modemStatus: 'REC UNREAD', read: false, onModem: true, sendStatus: null });
    // Reading never changed its status on the modem, and only reads were issued.
    expect(r.modem.sms.messages[0].status).toBe('REC UNREAD');
    expect(new Set(r.cmgl())).toEqual(new Set(['AT+CMGL="ALL",1']));
    expect(r.modem.sms.commands.some((c) => /^AT\+(CMGD|CMGR|CPMS=|CNMI=|CSCA=|CSMP=|CSCS=)/.test(c))).toBe(false);
    expect(r.inbox.state()).toMatchObject({ notificationsSeen: 1, storage: { name: 'ME', used: 1, total: 100 }, storageFull: false, lastError: null });
  });

  it('announces new messages without any sender or text in the notice', async () => {
    const r = await rig();
    r.inbox.start();
    r.modem.receiveSms('+911234567890', 'my secret text');
    await vi.waitFor(() => expect(r.alerts.some((a) => /new message/.test(a.message))).toBe(true));
    expect(r.alerts.map((a) => a.message)).toContain('SMS: 1 new message received');
    const all = JSON.stringify(r.alerts);
    expect(all).not.toContain('secret');
    expect(all).not.toContain('+9112');
  });

  it('several notifications close together are one read, and repeated notifications never create a second copy', async () => {
    const r = await rig({ debounceMs: 30 });
    r.inbox.start();
    await r.idle();
    r.modem.receiveSms('+911234567890', 'One');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1));
    await r.idle();
    const reads = r.cmgl().length;

    for (let i = 0; i < 5; i++) r.modem.emit('urc', cmti('ME', 1)); // the same notification, five times
    await vi.waitFor(() => expect(r.cmgl().length).toBe(reads + 1));
    await r.idle();
    expect(r.cmgl().length).toBe(reads + 1); // one read for all five
    expect(r.store.list().total).toBe(1); // still one message
    expect(r.alerts.filter((a) => /new message/.test(a.message))).toHaveLength(1);
  });

  it('a message that arrives while a read is running is picked up by one more read', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    r.modem.receiveSms('+911111111111', 'First');
    r.modem.receiveSms('+912222222222', 'Second');
    await vi.waitFor(() => expect(r.store.list().total).toBe(2));
    expect(r.store.list().messages.map((m) => m.text).sort()).toEqual(['First', 'Second']);
  });

  it('ignores other modem events and a notification when stopped', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    const before = r.cmgl().length;
    r.modem.emit('urc', { raw: 'RING', type: 'RING', timestamp: new Date().toISOString(), isSimulated: true });
    r.modem.emit('urc', { raw: 'ALERTING', type: 'CUSTOM', payload: { status: 'alerting' }, timestamp: new Date().toISOString(), isSimulated: true });
    r.inbox.stop();
    r.modem.emit('urc', cmti('ME', 1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.cmgl().length).toBe(before);
  });
});

describe('protecting calls and other SMS operations', () => {
  it('waits out a call without sending any AT command, then reads what arrived', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    r.state.call = { id: 'c1', state: 'ACTIVE' };
    r.modem.sms.commands.length = 0;
    r.modem.receiveSms('+911234567890', 'During the call');
    await new Promise((resolve) => setTimeout(resolve, 200)); // several re-checks
    expect(r.modem.sms.commands).toEqual([]); // nothing was sent to the modem during the call
    expect(r.inbox.state()).toMatchObject({ pending: true, waiting: 'call', lastError: null, consecutiveFailures: 0 });
    expect(r.store.list().total).toBe(0);

    r.state.call = null;
    r.eventBus.emit('call:ended', {} as never);
    await vi.waitFor(() => expect(r.store.list().total).toBe(1));
    expect(r.store.list().messages[0].text).toBe('During the call');
    expect(r.inbox.state()).toMatchObject({ pending: false, waiting: null });
  });

  it('waits for a send that is in progress instead of failing, then reads', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    const sending = r.service.send('+919876543210', 'Outgoing');
    r.modem.receiveSms('+911234567890', 'Arrived during a send');
    await vi.waitFor(() => expect(r.inbox.state().waiting).toBe('busy'));
    await sending;
    await vi.waitFor(() => expect(r.store.list({ direction: 'received' }).total).toBe(1));
    expect(r.inbox.state().consecutiveFailures).toBe(0);
  });

  it('waits for a modem that is not ready', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    await r.modem.close(); // DISCONNECTED
    r.modem.sms.commands.length = 0;
    r.inbox.requestSync('test');
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(r.modem.sms.commands).toEqual([]);
    expect(r.inbox.state()).toMatchObject({ pending: true, waiting: 'modem' });
    await r.modem.initialize(); // READY again: the connection event triggers the read
    r.modem.addIncomingSms('+911234567890', 'After reconnect');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1));
  });

  it('an explicit Refresh during a call is refused with the same error as every SMS operation', async () => {
    const r = await rig();
    r.state.call = { id: 'c1', state: 'ACTIVE' };
    const error = await r.inbox.syncNow().catch((e) => e as SmsError);
    expect(error).toMatchObject({ status: 409, code: 'CALL_IN_PROGRESS' });
    expect(r.modem.sms.commands).toEqual([]);
  });
});

describe('retrieval failures', () => {
  it('retries a failed read a bounded number of times and recovers', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    r.modem.sms.failNextList = 'CMS ERROR: SIM busy';
    r.modem.receiveSms('+911234567890', 'Eventually');
    await vi.waitFor(() => expect(r.inbox.state().consecutiveFailures).toBe(1));
    expect(r.inbox.state().lastError).toMatchObject({ code: 'SMS_CMS_ERROR' });
    await vi.waitFor(() => expect(r.store.list().total).toBe(1)); // the retry succeeded
    expect(r.inbox.state()).toMatchObject({ consecutiveFailures: 0, lastError: null, pending: false });
  });

  it('gives up after the retries, says so once, and does not touch the modem again until the next trigger', async () => {
    const r = await rig({ retryDelaysMs: [15, 15] });
    r.inbox.start();
    await r.idle();
    // A persistent fault: every read attempt fails until it is cleared below.
    const rearm = setInterval(() => {
      r.modem.sms.failNextList = 'CMS ERROR: SIM busy';
    }, 2);
    opened.push(() => clearInterval(rearm));
    r.modem.sms.failNextList = 'CMS ERROR: SIM busy';
    r.modem.receiveSms('+911234567890', 'Never read');
    await vi.waitFor(() => expect(r.inbox.state()).toMatchObject({ pending: false, consecutiveFailures: 3 }), { timeout: 3000 });
    clearInterval(rearm);
    r.modem.sms.failNextList = null;
    expect(r.alerts.filter((a) => /could not read/.test(a.message))).toHaveLength(1);

    const reads = r.cmgl().length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(r.cmgl().length).toBe(reads); // not retried any more
    expect(r.store.list().total).toBe(0);

    r.modem.receiveSms('+913333333333', 'Next one'); // a new notification starts over
    await vi.waitFor(() => expect(r.store.list().total).toBe(2)); // both are now read
    expect(r.inbox.state().consecutiveFailures).toBe(0);
  });

  it('reports an explicit Refresh failure to the caller without retrying it', async () => {
    const r = await rig();
    r.modem.sms.failNextList = 'CMS ERROR: SIM busy';
    const error = await r.inbox.syncNow().catch((e) => e as SmsError);
    expect(error).toMatchObject({ status: 502, code: 'SMS_CMS_ERROR' });
    expect(r.cmgl()).toHaveLength(1); // asked once
  });
});

describe('full storage and unusual storage settings', () => {
  it('reports a full storage and never deletes anything to make room', async () => {
    const r = await rig();
    r.modem.sms.storageTotal = 2;
    r.inbox.start();
    await r.idle();
    r.modem.receiveSms('+911111111111', 'One');
    r.modem.receiveSms('+912222222222', 'Two');
    await vi.waitFor(() => expect(r.inbox.state().storageFull).toBe(true));
    expect(r.inbox.state().storage).toMatchObject({ name: 'ME', used: 2, total: 2 });
    expect(r.alerts.filter((a) => a.level === 'warn' && /storage \(ME\) is full \(2\/2\)/.test(a.message))).toHaveLength(1);
    expect(r.alerts.map((a) => a.message).join(' ')).toMatch(/never deletes messages/);

    expect(r.modem.receiveSms('+913333333333', 'Does not fit')).toBeNull(); // the modem cannot take it, and says nothing
    await r.inbox.syncNow();
    expect(r.alerts.filter((a) => /is full/.test(a.message))).toHaveLength(1); // reported once, not on every read
    expect(r.modem.sms.messages).toHaveLength(2); // nothing removed
    expect(r.store.list().total).toBe(2);
    expect(r.modem.sms.commands.some((c) => /CMGD/.test(c))).toBe(false);

    r.modem.sms.storageTotal = 100; // the operator made room
    await r.inbox.syncNow();
    expect(r.inbox.state().storageFull).toBe(false);
    expect(r.alerts.map((a) => a.message)).toContain('SMS: the modem has room for new messages again');
  });

  it('says so when a notification names a storage other than the one being read, and does not change it', async () => {
    const r = await rig();
    r.inbox.start();
    await r.idle();
    r.modem.emit('urc', cmti('SM', 1));
    await vi.waitFor(() => expect(r.inbox.state().storageMismatch).toEqual({ indicated: 'SM', reading: 'ME' }));
    await r.idle();
    expect(r.alerts.filter((a) => /announces new messages in SM but the gateway reads ME/.test(a.message))).toHaveLength(1);
    expect(r.modem.sms.commands.some((c) => /^AT\+CPMS=/.test(c))).toBe(false);
  });

  it('warns once, without changing it, when the modem does not announce new messages', async () => {
    const r = await rig();
    r.modem.sms.cnmi = '2,0,0,0,0';
    r.inbox.start();
    await r.idle();
    await vi.waitFor(() => expect(r.inbox.state().indications).toEqual({ cnmi: [2, 0, 0, 0, 0], notifies: false }));
    await r.inbox.syncNow();
    expect(r.alerts.filter((a) => /does not announce new messages/.test(a.message))).toHaveLength(1);
    expect(r.modem.sms.commands.some((c) => /^AT\+CNMI=/.test(c))).toBe(false);
    expect(r.modem.receiveSms('+911234567890', 'Silent arrival')).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.store.list().total).toBe(0); // no notification, so no read until a Refresh
    expect((await r.inbox.syncNow()).added).toBe(1);
  });
});

describe('persistence', () => {
  it('catches up at start-up, survives a restart, and never duplicates a message', async () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const first = await rig({}, db);
    first.modem.addIncomingSms('+911234567890', 'Waiting on the SIM');
    first.modem.addIncomingSms('+919999999999', 'Another one');
    first.inbox.start(); // the modem is READY: read what is already there
    await vi.waitFor(() => expect(first.store.list().total).toBe(2));
    first.inbox.stop();

    // "Restart": a new service, store and inbox over the same database, the same modem content.
    const second = await rig({}, db);
    for (const m of first.modem.sms.messages) second.modem.sms.messages.push({ ...m });
    expect(second.store.list().total).toBe(2); // visible without touching the modem
    expect((await second.inbox.syncNow()).added).toBe(0);
    expect(second.store.list().total).toBe(2);
  });

  it('refreshes read/unread from the modem, flags a message that is no longer there, and keeps it', async () => {
    const r = await rig();
    r.modem.addIncomingSms('+911234567890', 'Keep me');
    await r.inbox.syncNow();
    expect(r.store.list().messages[0]).toMatchObject({ modemStatus: 'REC UNREAD', read: false });

    r.modem.sms.messages[0].status = 'REC READ'; // read by another client
    expect((await r.inbox.syncNow()).added).toBe(0);
    expect(r.store.list().messages[0]).toMatchObject({ modemStatus: 'REC READ', read: true, onModem: true });

    r.modem.sms.messages.length = 0; // deleted on the modem by something else
    await r.inbox.syncNow();
    expect(r.store.list().messages[0]).toMatchObject({ text: 'Keep me', onModem: false }); // kept
  });

  it('treats a reused index with different content as a different message', async () => {
    const r = await rig();
    r.modem.addIncomingSms('+911234567890', 'Old message');
    await r.inbox.syncNow();
    r.modem.sms.messages.length = 0;
    r.modem.addIncomingSms('+911234567890', 'New message in the same slot', 'REC UNREAD', '26/10/28,09:00:00+22');
    expect((await r.inbox.syncNow()).added).toBe(1);
    expect(r.store.list().total).toBe(2);
  });
});

describe('sent messages are recorded', () => {
  it('records a successful send, an uncertain one and a refused one, and nothing for requests that never reached the modem', async () => {
    const r = await rig();
    await r.service.send('+919876543210', 'Delivered');
    r.modem.sms.failNextSend = { timeout: 'completion' };
    await r.service.send('+919876543210', 'Uncertain').catch(() => {});
    r.modem.sms.failNextSend = { cms: 'Invalid text mode parameter' };
    await r.service.send('+919876543210', 'Refused').catch(() => {});
    await r.service.send('not a number', 'Invalid').catch(() => {});
    r.state.call = { id: 'c1' };
    await r.service.send('+919876543210', 'During a call').catch(() => {});

    const sent = r.store.list({ direction: 'sent' }).messages.reverse();
    expect(sent.map((m) => [m.text, m.sendStatus, m.errorCode])).toEqual([
      ['Delivered', 'sent', null],
      ['Uncertain', 'unknown', 'SMS_OUTCOME_UNKNOWN'],
      ['Refused', 'failed', 'SMS_CMS_ERROR'],
    ]);
    expect(sent[0]).toMatchObject({ direction: 'sent', source: 'gateway', address: '+919876543210', messageReference: 1, modemStatus: null, read: null });
  });

  it('a database problem does not turn a delivered message into an error', async () => {
    const r = await rig();
    vi.spyOn(r.store, 'recordSent').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(r.service.send('+919876543210', 'Still delivered')).resolves.toMatchObject({ success: true });
    expect(r.modem.sms.sent).toHaveLength(1);
  });
});

describe('structure', () => {
  it('never opens a port, never deletes a message, and never writes a storage or indication setting', () => {
    const dir = path.resolve(__dirname, '../src/sms');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const code = fs.readFileSync(path.join(dir, file), 'utf8');
      // (The SerialPortDisconnectedError class name is used only to map an error; nothing here opens a port.)
      expect(code, file).not.toMatch(/from 'serialport'|new SerialPort\(|NodeSerialTransport|ISerialTransport|\.open\(\{/);
      // Command strings only (a quote starts one); comments that say "never AT+CSAS" are fine.
      expect(code, file).not.toMatch(/['"`]AT\+(CNMI=|CSCA=|CSAS|CNMA)/);
      if (file !== 'sms-service.ts') expect(code, file).not.toMatch(/['"`]AT\+(CMGD|CPMS=)/);
    }
    // Deleting and selecting a storage exist only as the two operator-confirmed service actions, and nothing automatic calls them.
    const service = fs.readFileSync(path.join(dir, 'sms-service.ts'), 'utf8');
    const between = (from: string, to: string) => service.slice(service.indexOf(from), service.indexOf(to, service.indexOf(from)));
    // The storage section holds exactly storageInfo (read-only), selectStorage and deleteStored; nothing outside it.
    const elsewhere = service.replace(between('-- storage', '-- text-mode parameters'), '');
    expect(elsewhere).not.toMatch(/AT\+CMGD|AT\+CPMS="/);
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'sms-service.ts')) {
      expect(fs.readFileSync(path.join(dir, file), 'utf8'), file).not.toMatch(/deleteStored\(|selectStorage\(/);
    }
  });
});
