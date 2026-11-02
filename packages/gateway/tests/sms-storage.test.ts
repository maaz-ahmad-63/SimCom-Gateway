import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICallSessionManager } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { runMigrations } from '../src/db/migrations.js';
import { parseCpmsSupport } from '../src/sms/parse.js';
import { createGatewayServer } from '../src/server.js';
import { SmsInbox } from '../src/sms/sms-inbox.js';
import { deleteConfirmation, SmsService, storageConfirmation } from '../src/sms/sms-service.js';
import { SmsStore } from '../src/sms/sms-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A SIM that is full (SM 5/5) and a modem that also offers ME with room, as the SIM7600EI may. */
async function rig(options: { meSupported?: boolean } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  const store = new SmsStore(db);
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  await modem.initialize();
  modem.sms.storage = 'SM';
  modem.sms.storageTotal = 5;
  modem.sms.supportedStorages = options.meSupported === false ? { read: ['SM'], write: ['SM'], receive: ['SM'] } : { read: ['SM', 'ME'], write: ['SM', 'ME'], receive: ['SM', 'ME'] };
  modem.sms.otherStorages = options.meSupported === false ? {} : { ME: { total: 100, messages: [] } };
  for (let i = 1; i <= 5; i++) modem.addIncomingSms(`VM-VIINFO`, `Old notice ${i}`, 'REC READ', `26/10/1${i},10:00:00+22`);
  const state = { call: null as unknown };
  const callManager = { getCurrentCall: () => state.call } as unknown as ICallSessionManager;
  const eventBus = new GatewayEventBus();
  const alerts: string[] = [];
  eventBus.on('gateway:alert', (a) => void alerts.push(a.message));
  const service = new SmsService({ modem, callManager, store, commandTimeoutMs: 500 });
  const inbox = new SmsInbox({ service, store, modem, eventBus, debounceMs: 10, afterCallMs: 10, retryDelaysMs: [20], waitRecheckMs: 40, busyRecheckMs: 10, fallbackPollMs: 0 });
  cleanups.push(() => inbox.stop());
  const cmds = (re: RegExp) => modem.sms.commands.filter((c) => re.test(c));
  return { db, store, modem, state, service, inbox, alerts, eventBus, cmds };
}

describe('detecting what the modem can store messages in', () => {
  it('parses what AT+CPMS=? lists, and nothing when it says nothing', () => {
    expect(parseCpmsSupport('+CPMS: ("SM","ME","SR"),("SM","ME"),("SM","ME")\nOK')).toEqual({ read: ['SM', 'ME', 'SR'], write: ['SM', 'ME'], receive: ['SM', 'ME'] });
    expect(parseCpmsSupport('+CPMS: ("SM")\nOK')).toEqual({ read: ['SM'], write: [], receive: [] });
    expect(parseCpmsSupport('OK')).toBeNull();
  });

  it('reports used, total and free of the selected storage, which are supported, and that other sizes are unknown until selected', async () => {
    const r = await rig();
    const info = await r.service.storageInfo();
    expect(info.current).toMatchObject({ read: { name: 'SM', used: 5, total: 5, free: 0 }, write: { name: 'SM', free: 0 }, receive: { name: 'SM', free: 0 } });
    expect(info.options).toEqual([
      { name: 'SM', read: true, write: true, receive: true, usable: true, selected: true },
      { name: 'ME', read: true, write: true, receive: true, usable: true, selected: false },
    ]);
    expect(info.note).toMatch(/Only the selected storage reports its capacity/);
    expect(r.cmds(/^AT\+CPMS=/).every((c) => c === 'AT+CPMS=?')).toBe(true); // read-only: no selection command
  });

  it('says so when the modem offers only the SIM storage, and does not claim anything else', async () => {
    const r = await rig({ meSupported: false });
    const info = await r.service.storageInfo();
    expect((info.options as Array<{ name: string }>).map((o) => o.name)).toEqual(['SM']);
    await expect(r.service.selectStorage('ME', storageConfirmation('ME'))).rejects.toMatchObject({ code: 'STORAGE_UNSUPPORTED', status: 409 });
    expect(r.cmds(/^AT\+CPMS="/)).toEqual([]); // nothing was sent
  });

  it('refuses during a call', async () => {
    const r = await rig();
    r.state.call = { id: 'c1', state: 'ACTIVE' };
    await expect(r.service.storageInfo()).rejects.toMatchObject({ code: 'CALL_IN_PROGRESS' });
    await expect(r.service.selectStorage('ME', storageConfirmation('ME'))).rejects.toMatchObject({ code: 'CALL_IN_PROGRESS' });
    expect(r.modem.sms.commands).toEqual([]);
  });
});

describe('selecting a storage (explicit, verified, nothing moved or deleted)', () => {
  it('needs the exact confirmation and a valid name, and sends nothing without them', async () => {
    const r = await rig();
    await expect(r.service.selectStorage('ME', 'yes')).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', details: { required: 'USE ME FOR SMS STORAGE' } });
    await expect(r.service.selectStorage('ME"', 'x')).rejects.toMatchObject({ code: 'INVALID_STORAGE' });
    await expect(r.service.selectStorage(undefined, 'x')).rejects.toMatchObject({ code: 'INVALID_STORAGE' });
    expect(r.modem.sms.commands).toEqual([]);
  });

  it('selects ME for read, write and receive, verifies by read-back, reports the new capacity, and keeps the SIM messages', async () => {
    const r = await rig();
    const result = await r.service.selectStorage('me', storageConfirmation('ME'));
    expect(result).toMatchObject({ success: true, changed: true, verified: true, storage: 'ME', command: 'AT+CPMS="ME","ME","ME"' });
    expect(result.current).toMatchObject({ read: { name: 'ME', used: 0, total: 100, free: 100 } });
    expect(result.old).toMatchObject({ read: { name: 'SM', used: 5, total: 5, free: 0 } });
    expect(r.cmds(/^AT\+CPMS=/)).toEqual(['AT+CPMS=?', 'AT+CPMS="ME","ME","ME"']);
    expect(r.modem.sms.otherStorages.SM.messages).toHaveLength(5); // nothing deleted from the SIM
    expect(r.cmds(/CMGD/)).toEqual([]);
  });

  it('does nothing when that storage is already selected', async () => {
    const r = await rig();
    expect(await r.service.selectStorage('SM', storageConfirmation('SM'))).toMatchObject({ changed: false, verified: true });
    expect(r.cmds(/^AT\+CPMS="/)).toEqual([]);
  });

  it('reports a modem that refuses or does not apply it, never claiming success', async () => {
    const r = await rig();
    r.modem.sms.supportedStorages = { read: ['SM', 'ME'], write: ['SM', 'ME'], receive: ['SM'] }; // ME not offered for receive
    await expect(r.service.selectStorage('ME', storageConfirmation('ME'))).rejects.toMatchObject({ code: 'STORAGE_UNSUPPORTED' });
    const ignoring = await rig();
    const original = ignoring.modem.executeCommand.bind(ignoring.modem);
    ignoring.modem.executeCommand = async (command, timeout) => (command.startsWith('AT+CPMS="') ? 'OK' : original(command, timeout)); // OK, but nothing changes
    await expect(ignoring.service.selectStorage('ME', storageConfirmation('ME'))).rejects.toMatchObject({ code: 'STORAGE_VERIFY_FAILED' });
  });

  it('the inbox reads the selected storage, notifications and the fallback poll keep working, and stored copies are untouched', async () => {
    const r = await rig();
    r.inbox.start();
    await vi.waitFor(() => expect(r.store.list().total).toBe(5), { timeout: 3000 });
    expect(r.inbox.state()).toMatchObject({ storage: { name: 'SM', used: 5, total: 5 }, storageFull: true });
    expect(r.alerts.join(' ')).toMatch(/storage \(SM\) is full \(5\/5\)/);

    await vi.waitFor(() => expect(r.inbox.state()).toMatchObject({ syncing: false, pending: false }), { timeout: 3000 }); // never overlap a read
    await r.service.selectStorage('ME', storageConfirmation('ME'));
    r.modem.receiveSms('+911234567890', 'Arrives in ME');
    await vi.waitFor(() => expect(r.store.list().total).toBe(6), { timeout: 3000 });
    await vi.waitFor(() => expect(r.inbox.state()).toMatchObject({ storage: { name: 'ME', used: 1, total: 100 }, storageFull: false, syncing: false, pending: false }), { timeout: 3000 });
    expect(r.alerts.join(' ')).toMatch(/room for new messages again/);
    // The five SIM messages are still stored, and are not flagged as deleted just because another storage is being read.
    const rows = r.db.prepare("SELECT storage, on_modem FROM sms_messages WHERE storage = 'SM'").all() as Array<{ on_modem: number }>;
    expect(rows).toHaveLength(5);
    expect(rows.every((x) => x.on_modem === 1)).toBe(true);
    // Duplicate notification: nothing stored twice.
    r.modem.emit('urc', { raw: '+CMTI: "ME",1', type: 'CUSTOM', payload: { kind: 'sms-indication', storage: 'ME', index: 1 }, timestamp: new Date().toISOString(), isSimulated: true });
    await vi.waitFor(() => expect(r.inbox.state()).toMatchObject({ syncing: false, pending: false }));
    expect(r.store.list().total).toBe(6);
  });
});

describe('deleting from the SIM only on an explicit, checked request', () => {
  const idsOf = (r: Awaited<ReturnType<typeof rig>>) => r.store.list().messages.map((m) => m.id);

  it('never happens on its own: reading, syncing and a full storage delete nothing', async () => {
    const r = await rig();
    r.inbox.start();
    await vi.waitFor(() => expect(r.store.list().total).toBe(5), { timeout: 3000 });
    await r.inbox.syncNow();
    await r.service.storageInfo();
    expect(r.cmds(/CMGD/)).toEqual([]);
    expect(r.modem.sms.messages).toHaveLength(5);
  });

  it('refuses messages the gateway has not stored, and an unsafe selection, naming the problem and sending nothing', async () => {
    const r = await rig();
    await r.inbox.syncNow();
    await expect(r.service.deleteStored([9999], 'x')).rejects.toMatchObject({ code: 'NOT_SAFELY_STORED', status: 409 });
    await expect(r.service.deleteStored([], 'x')).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    await expect(r.service.deleteStored([1, 1], 'x')).rejects.toMatchObject({ code: 'INVALID_SELECTION' });
    r.store.recordSent({ to: '+911234567890', text: 'sent', status: 'sent' });
    const sentId = r.store.list({ direction: 'sent' }).messages[0].id;
    await expect(r.service.deleteStored([sentId], 'x')).rejects.toMatchObject({ code: 'NOT_SAFELY_STORED' });
    expect(r.cmds(/CMGD/)).toEqual([]);
  });

  it('needs the exact confirmation naming the count and the storage', async () => {
    const r = await rig();
    await r.inbox.syncNow();
    const ids = idsOf(r).slice(0, 2);
    await expect(r.service.deleteStored(ids, 'DELETE')).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED', details: { required: 'DELETE 2 MESSAGES FROM SM' } });
    expect(deleteConfirmation(1, 'ME')).toBe('DELETE 1 MESSAGE FROM ME');
    expect(r.cmds(/CMGD/)).toEqual([]);
  });

  it('re-checks the modem first: if an index no longer holds exactly the stored message, nothing is deleted', async () => {
    const r = await rig();
    await r.inbox.syncNow();
    const [first] = r.store.list().messages;
    r.modem.sms.messages.find((m) => m.index === first.index)!.text = 'A different message now in that slot';
    await expect(r.service.deleteStored([first.id], deleteConfirmation(1, 'SM'))).rejects.toMatchObject({ code: 'MODEM_CONTENT_CHANGED' });
    expect(r.cmds(/CMGD/)).toEqual([]);
    expect(r.modem.sms.messages).toHaveLength(5);
  });

  it('deletes exactly the confirmed messages, keeps the gateway copies, flags them as gone from the modem, and is refused during a call', async () => {
    const r = await rig();
    await r.inbox.syncNow();
    const messages = r.store.list().messages;
    const pick = messages.slice(0, 2).map((m) => m.id);
    r.state.call = { id: 'c1', state: 'ACTIVE' };
    await expect(r.service.deleteStored(pick, deleteConfirmation(2, 'SM'))).rejects.toMatchObject({ code: 'CALL_IN_PROGRESS' });
    expect(r.cmds(/CMGD/)).toEqual([]);
    r.state.call = null;

    const result = await r.service.deleteStored(pick, deleteConfirmation(2, 'SM'));
    expect(result).toMatchObject({ success: true, storage: 'SM' });
    expect([...(result.deleted as number[])].sort()).toEqual([...pick].sort());
    expect(r.cmds(/CMGD/)).toHaveLength(2);
    expect(r.modem.sms.messages).toHaveLength(3);
    const rows = r.db.prepare('SELECT id, on_modem, text FROM sms_messages ORDER BY id').all() as Array<{ id: number; on_modem: number; text: string }>;
    expect(rows).toHaveLength(5); // every copy is still in the gateway database
    expect(rows.filter((x) => x.on_modem === 0).map((x) => x.id).sort()).toEqual([...pick].sort());
    // The next read of the SIM does not add them again or flag the others.
    expect((await r.inbox.syncNow()).added).toBe(0);
  });

  it('stops at the first modem error and says what was and was not deleted; never retries', async () => {
    const r = await rig();
    await r.inbox.syncNow();
    const pick = idsOf(r).slice(0, 3);
    const original = r.modem.executeCommand.bind(r.modem);
    let calls = 0;
    r.modem.executeCommand = async (command, timeout) => {
      if (command.startsWith('AT+CMGD=') && ++calls === 2) {
        const { AtCommandError } = await import('@sim-gateway/shared');
        throw new AtCommandError(command, 'ERROR', 'AT ERROR');
      }
      return original(command, timeout);
    };
    const error = await r.service.deleteStored(pick, deleteConfirmation(3, 'SM')).catch((e) => e);
    expect(error).toMatchObject({ code: 'MODEM_ERROR' });
    expect(error.details.deleted).toHaveLength(1);
    expect(error.details.notAttempted).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe('the API', () => {
  const key = 'sms-storage-test-key-1234567890';
  async function server() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-storage-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    modem.sms.storage = 'SM';
    modem.sms.storageTotal = 5;
    modem.sms.otherStorages = { ME: { total: 100, messages: [] } };
    for (let i = 1; i <= 5; i++) modem.addIncomingSms('VM-VIINFO', `Old ${i}`, 'REC READ', `26/10/1${i},10:00:00+22`);
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
    const call = (m: 'get' | 'post', url: string) => request(s.app)[m](url).set('x-api-key', key);
    return { s, modem, call };
  }

  it('requires the key, reports capacity, selects with confirmation, and reads the new storage after it', async () => {
    const { s, modem, call } = await server();
    s.smsInbox.start();
    cleanups.push(() => s.smsInbox.stop());
    await vi.waitFor(() => expect(s.smsInbox.state()).toMatchObject({ lastSuccessAt: expect.any(String), syncing: false, pending: false }), { timeout: 5000 });
    expect((await request(s.app).get('/api/gateway/sms/storage')).status).toBe(401);
    expect((await request(s.app).post('/api/gateway/sms/delete').send({})).status).toBe(401);

    const info = await call('get', '/api/gateway/sms/storage');
    expect(info.body.current.read).toMatchObject({ name: 'SM', used: 5, total: 5, free: 0 });
    expect((await call('post', '/api/gateway/sms/storage').send({ storage: 'ME' })).body).toMatchObject({ success: false, code: 'CONFIRMATION_REQUIRED' });
    const selected = await call('post', '/api/gateway/sms/storage').send({ storage: 'ME', confirm: 'USE ME FOR SMS STORAGE' });
    expect(selected.body).toMatchObject({ success: true, changed: true, verified: true });
    await vi.waitFor(() => expect(s.smsInbox.state().storage).toMatchObject({ name: 'ME', total: 100 }), { timeout: 5000 });
    modem.receiveSms('+911234567890', 'New one');
    await call('post', '/api/gateway/sms/sync');
    expect(s.smsStore.list({ direction: 'received' }).messages.some((m) => m.text === 'New one')).toBe(true);
  });

  it('deletes only with the confirmation and only stored messages, and keeps the stored copy', async () => {
    const { s, modem, call } = await server();
    await call('post', '/api/gateway/sms/sync');
    const ids = s.smsStore.list({ direction: 'received' }).messages.slice(0, 1).map((m) => m.id);
    expect((await call('post', '/api/gateway/sms/delete').send({ ids })).body.code).toBe('CONFIRMATION_REQUIRED');
    expect((await call('post', '/api/gateway/sms/delete').send({ ids: [424242], confirm: 'x' })).body.code).toBe('NOT_SAFELY_STORED');
    expect(modem.sms.messages).toHaveLength(5);
    const done = await call('post', '/api/gateway/sms/delete').send({ ids, confirm: 'DELETE 1 MESSAGE FROM SM' });
    expect(done.body).toMatchObject({ success: true, deleted: ids });
    expect(modem.sms.messages).toHaveLength(4);
    expect(s.smsStore.list({ direction: 'received' }).total).toBe(5);
  });
});
