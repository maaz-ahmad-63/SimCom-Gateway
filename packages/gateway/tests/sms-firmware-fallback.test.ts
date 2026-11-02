import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICallSessionManager, SerialPortDisconnectedError } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { runMigrations } from '../src/db/migrations.js';
import { createGatewayServer } from '../src/server.js';
import { SmsInbox, SmsInboxOptions } from '../src/sms/sms-inbox.js';
import { SmsService } from '../src/sms/sms-service.js';
import { SmsStore } from '../src/sms/sms-store.js';

/**
 * The SIM7600 on COM20 answers a bare ERROR to AT+CMGL="ALL",1 (list without changing status): every read failed with
 * MODEM_ERROR, nothing reached the database, and the inbox stayed empty. These tests play that firmware on the mock modem.
 */
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function rig(options: Partial<SmsInboxOptions> & { firmwareRejectsMode?: boolean } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  const store = new SmsStore(db);
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  await modem.initialize();
  modem.sms.listModeSupported = options.firmwareRejectsMode !== true;
  const state = { call: null as unknown };
  const callManager = { getCurrentCall: () => state.call } as unknown as ICallSessionManager;
  const eventBus = new GatewayEventBus();
  const alerts: string[] = [];
  eventBus.on('gateway:alert', (a) => void alerts.push(a.message));
  const service = new SmsService({ modem, callManager, store, commandTimeoutMs: 500 });
  const inbox = new SmsInbox({ service, store, modem, eventBus, debounceMs: 10, afterCallMs: 10, retryDelaysMs: [30], waitRecheckMs: 40, busyRecheckMs: 10, fallbackPollMs: 0, ...options });
  cleanups.push(() => inbox.stop());
  const lists = () => modem.sms.commands.filter((c) => c.startsWith('AT+CMGL="'));
  const idle = () => vi.waitFor(() => expect(inbox.state()).toMatchObject({ syncing: false, pending: false }), { timeout: 3000 });
  return { db, store, modem, state, eventBus, alerts, service, inbox, lists, idle };
}

describe('firmware that rejects AT+CMGL="ALL",1 (the reported MODEM_ERROR)', () => {
  it('falls back to the standard listing once, stores the message unread, and shows it', async () => {
    const r = await rig({ firmwareRejectsMode: true });
    r.inbox.start();
    r.modem.receiveSms('+911234567890', 'Hello from a phone');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1), { timeout: 3000 });
    await r.idle();
    expect(r.store.list().messages[0]).toMatchObject({ address: '+911234567890', text: 'Hello from a phone', read: false, modemStatus: 'REC UNREAD' });
    expect(r.inbox.state()).toMatchObject({ lastError: null, listMode: 'standard', consecutiveFailures: 0 });
    // The rejected form was tried, then the standard one; and the rejected form is not sent again on this connection.
    expect(r.lists().slice(0, 2)).toEqual(['AT+CMGL="ALL",1', 'AT+CMGL="ALL"']);
    r.modem.receiveSms('+911234567891', 'Second');
    await vi.waitFor(() => expect(r.store.list().total).toBe(2), { timeout: 3000 });
    expect(r.lists().filter((c) => c.endsWith(',1'))).toHaveLength(1);
  });

  it('keeps a message unread in the dashboard although the standard listing flagged it read on the SIM', async () => {
    const r = await rig({ firmwareRejectsMode: true });
    r.inbox.start();
    r.modem.receiveSms('+911234567890', 'Still unread');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1), { timeout: 3000 });
    await r.idle();
    expect(r.modem.sms.messages[0].status).toBe('REC READ'); // what the SIM now says, because of the standard listing
    await r.inbox.syncNow(); // a second read sees REC READ...
    expect(r.store.list()).toMatchObject({ unread: 1 }); // ...and the gateway's record stays unread
    expect(r.store.list().messages[0].read).toBe(false);
  });

  it('uses the status-preserving listing where the firmware accepts it, and then takes the modem status as it is', async () => {
    const r = await rig();
    r.inbox.start();
    r.modem.receiveSms('+911234567890', 'Preserved');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1), { timeout: 3000 });
    await r.idle();
    expect(r.inbox.state().listMode).toBe('status-preserving');
    expect(r.modem.sms.messages[0].status).toBe('REC UNREAD');
    expect(r.lists().every((c) => c.endsWith(',1'))).toBe(true);
  });

  it('the plain API listing still reports the rejection with the command and the markRead hint (no silent change of behavior)', async () => {
    const r = await rig({ firmwareRejectsMode: true });
    const error = await r.service.list({ status: 'all' }).catch((e) => e);
    expect(error).toMatchObject({ code: 'MODEM_ERROR' });
    expect(error.details).toMatchObject({ command: 'AT+CMGL="ALL",1' });
    expect(error.details.markReadHint).toMatch(/markRead=true/);
    expect(r.lists()).toEqual(['AT+CMGL="ALL",1']); // nothing else was sent
  });

  it('when both listings fail, nothing is concluded about the firmware and the error says which command failed', async () => {
    const r = await rig();
    const original = r.modem.executeCommand.bind(r.modem);
    r.modem.executeCommand = async (command, timeoutMs) => {
      if (command.startsWith('AT+CMGL="')) {
        r.modem.sms.commands.push(command);
        const { AtCommandError } = await import('@sim-gateway/shared');
        throw new AtCommandError(command, 'ERROR', `AT command '${command}' failed: AT ERROR for 9876543210`);
      }
      return original(command, timeoutMs);
    };
    await expect(r.inbox.syncNow()).rejects.toMatchObject({ code: 'MODEM_ERROR' });
    expect(r.service.listCapability()).toBeNull();
    r.inbox.start();
    r.inbox.requestSync('test');
    await vi.waitFor(() => expect(r.inbox.state().lastError).not.toBeNull(), { timeout: 3000 });
    const last = r.inbox.state().lastError!;
    expect(last).toMatchObject({ code: 'MODEM_ERROR', command: 'AT+CMGL="ALL"' });
    expect(last.hint).toMatch(/The modem answered ERROR to AT\+CMGL="ALL"/);
    expect(last.message).not.toContain('9876543210'); // sanitized
  });
});

describe('the other ways a read can fail', () => {
  it('a serial disconnect is a wait for the modem, not a failure; the read happens once it is back', async () => {
    const r = await rig();
    const original = r.modem.executeCommand.bind(r.modem);
    let unplugged = true;
    r.modem.executeCommand = async (command, timeoutMs) => {
      if (unplugged && command.startsWith('AT+CMGL="')) throw new SerialPortDisconnectedError('COM20', 'Serial port COM20 closed');
      return original(command, timeoutMs);
    };
    r.modem.addIncomingSms('+911234567890', 'Arrived while unplugged');
    r.inbox.start();
    await vi.waitFor(() => expect(r.inbox.state().waiting).toBe('modem'), { timeout: 3000 });
    expect(r.inbox.state()).toMatchObject({ consecutiveFailures: 0, lastError: null });
    unplugged = false;
    r.modem.emit('connection_state', 'DISCONNECTED');
    r.modem.emit('connection_state', 'READY');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1), { timeout: 3000 });
  });

  it('a reconnect forgets what it learned about the listing, so a replaced modem is asked again', async () => {
    const r = await rig({ firmwareRejectsMode: true });
    r.inbox.start();
    await r.idle();
    expect(r.service.listCapability()).toBe('standard');
    r.modem.emit('connection_state', 'DISCONNECTED');
    expect(r.service.listCapability()).toBe('standard');
    r.modem.emit('connection_state', 'READY');
    expect(r.service.listCapability()).toBeNull();
  });

  it('a database failure is reported as SMS_STORE_ERROR, keeps the messages on the modem, and the next read stores them', async () => {
    const r = await rig();
    const spy = vi.spyOn(r.store, 'upsertFromModem').mockImplementationOnce(() => {
      throw new Error('SQLITE_FULL: database or disk is full');
    });
    r.modem.addIncomingSms('+911234567890', 'Kept on the modem');
    await expect(r.inbox.syncNow()).rejects.toMatchObject({ code: 'SMS_STORE_ERROR' });
    expect(r.modem.sms.messages).toHaveLength(1); // nothing was deleted
    spy.mockRestore();
    await r.inbox.syncNow();
    expect(r.store.list().total).toBe(1);
  });
});

describe('the inbox API', () => {
  const key = 'firmware-fallback-key-123456';
  async function server() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-fw-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    modem.sms.listModeSupported = false;
    const s = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
    });
    cleanups.push(async () => {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return { s, modem, api: (url: string) => request(s.app).get(url).set('x-api-key', key) };
  }

  it('lists stored messages without touching the modem, even while the modem is unavailable', async () => {
    const { s, modem, api } = await server();
    modem.addIncomingSms('+911234567890', 'Already stored');
    await request(s.app).post('/api/gateway/sms/sync').set('x-api-key', key);
    await modem.close(); // the modem goes away
    const before = modem.sms.commands.length;
    const page = await api('/api/gateway/sms/inbox?direction=received');
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ total: 1, unread: 1 });
    expect(page.body.inbox.listMode).toBe('standard');
    expect(modem.sms.commands.length).toBe(before);
  });

  it('reports a database failure as SMS_STORE_ERROR, not as an empty inbox', async () => {
    const { s, api } = await server();
    vi.spyOn(s.smsStore, 'list').mockImplementationOnce(() => {
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
    });
    const page = await api('/api/gateway/sms/inbox?direction=received');
    expect(page.status).toBe(500);
    expect(page.body).toMatchObject({ success: false, code: 'SMS_STORE_ERROR' });
    expect(page.body.messages).toBeUndefined();
  });
});
