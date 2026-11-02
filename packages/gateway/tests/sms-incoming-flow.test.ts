import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ICallSessionManager, SerialPortDisconnectedError } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { Sim7600HardwareAdapter } from '../src/adapters/modem/hardware-modem.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { FakeSerialTransport, SerialTransportOptions } from '../src/adapters/modem/serial-transport.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { runMigrations } from '../src/db/migrations.js';
import { SerialInterfaceInfo } from '../src/hardware/port-discovery.js';
import { createGatewayServer, GatewayServerInstance, smsFallbackPollMs } from '../src/server.js';
import { SmsInbox, SmsInboxOptions } from '../src/sms/sms-inbox.js';
import { SmsService } from '../src/sms/sms-service.js';
import { SmsStore } from '../src/sms/sms-store.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** The watcher over a mock modem. `notify: false` is a modem whose +CMTI never reaches the AT port. */
async function rig(options: Partial<SmsInboxOptions> & { notify?: boolean } = {}) {
  const db = new Database(':memory:');
  runMigrations(db);
  const store = new SmsStore(db);
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  await modem.initialize();
  if (options.notify === false) modem.sms.cnmi = '2,0,0,0,0';
  const state = { call: null as unknown };
  const callManager = { getCurrentCall: () => state.call } as unknown as ICallSessionManager;
  const eventBus = new GatewayEventBus();
  const alerts: string[] = [];
  eventBus.on('gateway:alert', (alert) => void alerts.push(alert.message));
  const service = new SmsService({ modem, callManager, store, commandTimeoutMs: 500 });
  const inbox = new SmsInbox({ service, store, modem, eventBus, debounceMs: 10, afterCallMs: 10, retryDelaysMs: [20], waitRecheckMs: 40, busyRecheckMs: 10, ...options });
  cleanups.push(() => inbox.stop());
  const reads = () => modem.sms.commands.filter((c) => c.startsWith('AT+CMGL=')).length;
  const idle = () => vi.waitFor(() => expect(inbox.state()).toMatchObject({ syncing: false, pending: false }), { timeout: 3000 });
  return { db, store, modem, state, eventBus, alerts, inbox, reads, idle };
}

describe('incoming messages appear without a click', () => {
  it('when the modem announces nothing, the fallback poll still brings new messages in', async () => {
    const r = await rig({ notify: false, fallbackPollMs: 600 });
    r.inbox.start();
    await r.idle();
    expect(r.inbox.state().polling).toEqual({ mode: 'fallback', intervalMs: 600 });
    r.modem.receiveSms('+911234567890', 'No notification for me');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1), { timeout: 3000 });
    expect(r.store.list().messages[0]).toMatchObject({ text: 'No notification for me', read: false });
    expect(r.modem.sms.messages[0].status).toBe('REC UNREAD'); // the poll never marks anything read
    expect(r.alerts.join(' ')).toMatch(/does not announce new messages .* checks the storage every 1 s instead/);
  });

  it('stops polling once a real notification has arrived, and from then on reads only on notifications', async () => {
    const r = await rig({ fallbackPollMs: 500 });
    r.inbox.start();
    await r.idle();
    r.modem.receiveSms('+911234567890', 'Announced');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1));
    await r.idle();
    expect(r.inbox.state().polling).toEqual({ mode: 'off', intervalMs: null });
    const before = r.reads();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(r.reads()).toBe(before); // no more polling reads
  });

  it('a fixed poll interval replaces the fallback, and 0 turns the fallback off', async () => {
    const fixed = await rig({ pollIntervalMs: 70_000 });
    fixed.inbox.start();
    expect(fixed.inbox.state().polling).toEqual({ mode: 'interval', intervalMs: 70_000 });
    const off = await rig({ fallbackPollMs: 0 });
    off.inbox.start();
    expect(off.inbox.state().polling).toEqual({ mode: 'off', intervalMs: null });
    expect([smsFallbackPollMs(undefined), smsFallbackPollMs(''), smsFallbackPollMs('0'), smsFallbackPollMs('5000'), smsFallbackPollMs('300000'), smsFallbackPollMs('x')]).toEqual([120_000, 120_000, 0, 60_000, 300_000, 120_000]);
  });

  it('the poll sends nothing to the modem during a call, and catches up when it ends', async () => {
    const r = await rig({ notify: false, fallbackPollMs: 500 });
    r.inbox.start();
    await r.idle();
    r.state.call = { id: 'c1', state: 'ACTIVE' };
    const before = r.modem.sms.commands.length;
    r.modem.receiveSms('+911234567890', 'During the call');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    expect(r.modem.sms.commands.length).toBe(before); // not one AT command while the call lasted
    expect(r.store.list().total).toBe(0);
    r.state.call = null;
    r.eventBus.emit('call:ended', {} as never);
    await vi.waitFor(() => expect(r.store.list().total).toBe(1), { timeout: 3000 });
  });

  it('after a reconnect it reads again, re-reads the indication setting, and stores nothing twice', async () => {
    const r = await rig({ fallbackPollMs: 0 });
    r.inbox.start();
    r.modem.receiveSms('+911234567890', 'Before the drop');
    await vi.waitFor(() => expect(r.store.list().total).toBe(1));
    await r.idle();
    const cnmiReads = () => r.modem.sms.commands.filter((c) => c === 'AT+CNMI?').length;
    const firstCnmi = cnmiReads();

    r.modem.emit('connection_state', 'DISCONNECTED');
    r.modem.emit('connection_state', 'READY');
    // The same notification delivered again after the reconnect, as some firmware does.
    r.modem.emit('urc', { raw: '+CMTI: "ME",1', type: 'CUSTOM', payload: { kind: 'sms-indication', storage: 'ME', index: 1 }, timestamp: new Date().toISOString(), isSimulated: true });
    await vi.waitFor(() => expect(cnmiReads()).toBe(firstCnmi + 1), { timeout: 3000 });
    await r.idle();
    expect(r.store.list().total).toBe(1);
    expect(r.alerts.filter((a) => /new message/.test(a))).toHaveLength(1);
  });
});

describe('end to end through the gateway API (mock modem)', () => {
  const key = 'incoming-flow-test-key-123456';

  function gateway(dir: string, modem: MockModemAdapter): GatewayServerInstance {
    return createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'gateway.sqlite'), audioDumpDir: path.join(dir, 'rec') },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
    });
  }

  it('a notification becomes a stored, unread inbox message the dashboard can list, with a realtime nudge, and survives a restart once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-flow-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    let server = gateway(dir, modem);
    const alerts: string[] = [];
    server.eventBus.on('gateway:alert', (a) => void alerts.push(a.message));
    server.smsInbox.start();
    cleanups.push(() => server.close());

    modem.receiveSms('+911234567890', 'Hello from a phone');
    await vi.waitFor(() => expect(server.smsStore.list().total).toBe(1), { timeout: 5000 });
    await vi.waitFor(() => expect(alerts).toContain('SMS: 1 new message received')); // the dashboard reloads its list on this (Socket.IO gateway:alert)

    // Opening the inbox page: database only, no AT command, nothing marked read.
    const commandsBefore = modem.sms.commands.length;
    const page = await request(server.app).get('/api/gateway/sms/inbox?direction=received').set('x-api-key', key);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ success: true, total: 1, unread: 1 });
    expect(page.body.messages[0]).toMatchObject({ address: '+911234567890', text: 'Hello from a phone', read: false, modemStatus: 'REC UNREAD' });
    expect(typeof page.body.messages[0].time).toBe('string');
    expect(page.body.inbox).toMatchObject({ running: true, lastError: null, polling: { mode: 'off' } });
    expect(modem.sms.commands.length).toBe(commandsBefore);
    expect(modem.sms.messages[0].status).toBe('REC UNREAD');

    // Restart: the same database, a fresh gateway. The start-up read finds the same message and adds nothing.
    await server.close();
    cleanups.pop();
    await modem.initialize(); // closing the gateway closed the modem; a restarted gateway opens it again
    server = gateway(dir, modem);
    cleanups.push(() => server.close());
    const restarted: string[] = [];
    server.eventBus.on('gateway:alert', (a) => void restarted.push(a.message));
    server.smsInbox.start();
    await vi.waitFor(() => expect(server.smsInbox.state().lastSuccessAt).not.toBeNull(), { timeout: 5000 });
    expect(server.smsStore.list().total).toBe(1);
    expect(restarted.filter((a) => /new message/.test(a))).toEqual([]);
  }, 20_000);

  it('Refresh from modem reads the storage into the database and returns what it added; a failure is reported, not retried', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sms-flow-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    await modem.initialize();
    const server = gateway(dir, modem);
    cleanups.push(() => server.close());
    modem.addIncomingSms('+919000000001', 'Stored before the gateway ran'); // no notification at all
    const sync = await request(server.app).post('/api/gateway/sms/sync').set('x-api-key', key);
    expect(sync.status).toBe(200);
    expect(sync.body).toMatchObject({ success: true, added: 1 });
    expect(server.smsStore.list().messages[0].read).toBe(false);

    modem.sms.failNextList = 'CMS ERROR: SIM busy';
    const reads = () => modem.sms.commands.filter((c) => c.startsWith('AT+CMGL=')).length;
    const before = reads();
    const failed = await request(server.app).post('/api/gateway/sms/sync').set('x-api-key', key);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(failed.body.success).toBe(false);
    expect(reads()).toBe(before + 1); // one attempt, no automatic retry of the explicit refresh
  });
});

/** A fake port that records opens and can fail them, to play an unplugged modem. */
class PlugTransport extends FakeSerialTransport {
  unplugged = true;
  opens = 0;
  concurrent = 0;
  maxConcurrent = 0;
  async open(options?: Partial<SerialTransportOptions>): Promise<void> {
    this.concurrent++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      await new Promise((resolve) => setTimeout(resolve, 2));
      if (this.unplugged) throw new SerialPortDisconnectedError(options?.path ?? this.path, 'File not found');
      this.opens++;
      await super.open();
    } finally {
      this.concurrent--;
    }
  }
}

describe('hardware mode: discovery status and recovery (fake transport, nothing is opened for real)', () => {
  const key = 'hardware-flow-test-key-1234567890';
  const modemPorts = (at: string, audio: string, parent = '6&ABCD&0'): SerialInterfaceInfo[] => [
    { path: at, vendorId: '1E0E', productId: '9001', pnpId: `USB\\VID_1E0E&PID_9001&MI_02\\${parent}&0002`, friendlyName: `SimTech HS-USB AT Port 9001 (${at})` },
    { path: audio, vendorId: '1E0E', productId: '9001', pnpId: `USB\\VID_1E0E&PID_9001&MI_04\\${parent}&0004`, friendlyName: `SimTech HS-USB Audio 9001 (${audio})` },
  ];

  /** The test process loads the real .env; none of its modem settings may decide these tests. */
  function cleanEnv(): void {
    const saved: Record<string, string | undefined> = {};
    for (const name of ['MODEM_AT_PORT', 'MODEM_AUDIO_PORT', 'MODEM_DEVICE']) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    cleanups.push(() => {
      for (const [name, value] of Object.entries(saved)) if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }

  function hardwareGateway(listing: () => SerialInterfaceInfo[], modem: Sim7600HardwareAdapter | MockModemAdapter, config: Record<string, unknown> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hw-flow-'));
    const server = createGatewayServer({
      config: { modemDriver: 'hardware', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'gateway.sqlite'), audioDumpDir: path.join(dir, 'rec'), port: 40000 + Math.floor(Math.random() * 9000), host: '127.0.0.1', ...config },
      modem,
      audio: new MockAudioAdapter(),
      instanceLockDir: dir,
      listSerialPorts: async () => listing(),
      modemWatchMs: 40,
    });
    cleanups.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return server;
  }

  it('reports the discovered ports, the modem identity and every modem found; it never suggests writing COM numbers to .env', async () => {
    cleanEnv();
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const server = hardwareGateway(() => [...modemPorts('COM20', 'COM19', '6&AAAA&0'), ...modemPorts('COM25', 'COM26', '6&BBBB&0')], modem);
    expect(server.config).toMatchObject({ atPort: 'auto', audioPort: 'auto' });
    await server.portDiscovery!.scan();
    const status = await request(server.app).get('/api/gateway/hardware/status').set('x-api-key', key);
    expect(status.body.discovery).toMatchObject({ mode: 'discovery', ok: false, code: 'MULTIPLE_MODEMS', at: null, audio: null });
    expect(status.body.discovery.modems.map((m: { id: string }) => m.id)).toEqual(['1E0E:9001:6&AAAA&0', '1E0E:9001:6&BBBB&0']);
    expect(status.body.modem.configuredAtPort).toBe('auto'); // not found yet, and said so; never a guessed COM number

    const ports = await request(server.app).get('/api/gateway/hardware/ports').set('x-api-key', key);
    expect(ports.body).toMatchObject({ mode: 'discovery', suggestedEnv: null });
    expect(ports.body.findings[0]).toMatchObject({ level: 'error' });
    expect(ports.body.findings[0].message).toMatch(/does not guess/);
    expect(ports.body.modems).toHaveLength(2);
  });

  it('shows the ports in use once one modem is found', async () => {
    cleanEnv();
    const server = hardwareGateway(() => modemPorts('COM20', 'COM19'), new MockModemAdapter({ autoAnswerDelayMs: 0 }));
    await server.portDiscovery!.resolveAt();
    const status = await request(server.app).get('/api/gateway/hardware/status').set('x-api-key', key);
    expect(status.body.modem).toMatchObject({ configuredAtPort: 'COM20', configuredAudioPort: 'COM19' });
    expect(status.body.discovery).toMatchObject({ ok: true, at: 'COM20', audio: 'COM19', device: { id: '1E0E:9001:6&ABCD&0' } });
    const health = await request(server.app).get('/api/gateway/health').set('x-api-key', key);
    expect(health.body.modem).toMatchObject({ atPort: 'COM20', audioPort: 'COM19' });
  });

  it('keeps explicit MODEM_AT_PORT / MODEM_AUDIO_PORT as given', async () => {
    cleanEnv();
    const server = hardwareGateway(() => modemPorts('COM20', 'COM19'), new MockModemAdapter({ autoAnswerDelayMs: 0 }), { atPort: 'COM33', audioPort: 'COM34' });
    await server.portDiscovery!.scan();
    const status = await request(server.app).get('/api/gateway/hardware/status').set('x-api-key', key);
    expect(status.body.discovery).toMatchObject({ mode: 'explicit', at: 'COM33', audio: 'COM34' });
    expect(status.body.discovery.warnings.join(' ')).toMatch(/COM33 \(set explicitly\) is not present/);
  });

  it('brings the modem back after the adapter gave up, once it is plugged in again, with one connection only', async () => {
    cleanEnv();
    let present = false;
    const transport = new PlugTransport('COM20');
    transport.onWrite((w) => transport.feedIncomingData(w.includes('AT+CPIN?') ? '+CPIN: READY\r\nOK\r\n' : w.includes('AT+CNMI?') ? '+CNMI: 2,1,0,0,0\r\nOK\r\n' : 'OK\r\n'));
    const modem = new Sim7600HardwareAdapter({ atPort: 'COM20', commandTimeoutMs: 300, autoReconnect: true, reconnectIntervalMs: 10, maxReconnectAttempts: 1, transport });
    modem.on('error', () => {});
    const server = hardwareGateway(() => (present ? modemPorts('COM20', 'COM19') : []), modem, { atPort: 'COM20', audioPort: 'COM19', autoReconnect: true });
    await server.start();

    // Unplugged at start: the adapter tries, retries once, and gives up.
    await vi.waitFor(() => expect(modem.getDiagnostics()).toMatchObject({ reconnectScheduled: false, reconnectAttempts: 1 }), { timeout: 3000 });
    expect(['ERROR', 'DISCONNECTED']).toContain(modem.getConnectionState());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(transport.opens).toBe(0); // the watcher only listed ports: the modem is not there, so nothing was opened

    present = true;
    transport.unplugged = false;
    await vi.waitFor(() => expect(modem.getConnectionState()).toBe('READY'), { timeout: 3000 });
    expect(transport.opens).toBe(1);
    expect(transport.maxConcurrent).toBe(1);
  });
});
