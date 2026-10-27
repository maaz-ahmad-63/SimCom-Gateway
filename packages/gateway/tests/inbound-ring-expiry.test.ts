import { afterEach, describe, expect, it, vi } from 'vitest';
import { io as ClientSocket } from 'socket.io-client';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CallSession } from '@sim-gateway/shared';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { CallSessionManager } from '../src/core/call-session-manager.js';
import { GatewayEventBus } from '../src/core/event-bus.js';
import { createGatewayServer } from '../src/server.js';

const ring = () => ({ raw: '+CRING: VOICE', type: 'RING', timestamp: new Date().toISOString(), isSimulated: false });

describe('an inbound call whose rings stop', () => {
  afterEach(() => vi.useRealTimers());

  const harness = async () => {
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 100 });
    const eventBus = new GatewayEventBus();
    const manager = new CallSessionManager({ modem, audio: new MockAudioAdapter(), eventBus });
    await modem.initialize();
    const ended: CallSession[] = [];
    eventBus.on('call:ended', (s) => ended.push(s));
    return { modem, manager, ended };
  };

  it('ends as missed once no ring has been seen for the stale window, so the banner clears', async () => {
    const { modem, manager, ended } = await harness();
    vi.useFakeTimers();
    modem.emit('urc', ring());
    expect(manager.getCurrentCall()?.state).toBe('INBOUND_RINGING');

    vi.advanceTimersByTime(14_000);
    expect(manager.getCurrentCall()?.state).toBe('INBOUND_RINGING'); // not yet

    vi.advanceTimersByTime(2_000);
    expect(manager.getCurrentCall()).toBeNull();
    expect(ended).toHaveLength(1);
    expect(ended[0].outcome).toBe('missed');
    expect(ended[0].endedAt).not.toBeNull();
    await modem.close();
  });

  it('keeps ringing while rings keep arriving', async () => {
    const { modem, manager, ended } = await harness();
    vi.useFakeTimers();
    for (let i = 0; i < 8; i++) {
      modem.emit('urc', ring());
      vi.advanceTimersByTime(5_000); // 40 s in total, never 15 s without a ring
    }
    expect(manager.getCurrentCall()?.state).toBe('INBOUND_RINGING');
    expect(ended).toHaveLength(0);
    await modem.close();
  });

  it('does not end a call that was answered', async () => {
    const { modem, manager, ended } = await harness();
    modem.emit('urc', ring());
    modem.emit('urc', { raw: '+CLIP: "+919123456789",145', type: 'CLIP', phoneNumber: '+919123456789', typeOfAddress: 145, timestamp: new Date().toISOString(), isSimulated: false });
    await manager.answer();
    vi.useFakeTimers();
    vi.advanceTimersByTime(60_000);
    expect(manager.getCurrentCall()?.state).toBe('ACTIVE');
    expect(ended).toHaveLength(0);
    vi.useRealTimers();
    await manager.hangup();
    await modem.close();
  });
});

describe('the connect snapshot cannot erase a call that rang while it waited', () => {
  it('reports the call that exists when the snapshot is sent, not the one before its AT queries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ring-snap-'));
    const port = 50152 + Math.floor(Math.random() * 1000);
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 50 });
    const key = 'snapshot-race-key-12345';
    const server = createGatewayServer({
      config: { port, host: '127.0.0.1', gatewayApiKey: key, sqliteDbPath: path.join(dir, 'g.sqlite') },
      modem,
      audio: new MockAudioAdapter({ frameDurationMs: 10 }),
      instanceLockDir: dir,
    });
    await server.start();

    // The modem answers its AT queries slowly, as a flapping one does.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = async <T,>(v: T): Promise<T> => { await gate; return v; };
    vi.spyOn(modem, 'getSignalQuality').mockImplementation(() => slow({ rssi: 20, ber: 0, dbm: -73, quality: 'good' } as never));
    vi.spyOn(modem, 'getNetworkStatus').mockImplementation(() => slow(null as never));
    vi.spyOn(modem, 'getDeviceInfo').mockImplementation(() => slow(null as never));

    const client = ClientSocket(`http://127.0.0.1:${port}`, { auth: { token: key }, transports: ['websocket'] });
    const snapshots: Array<CallSession | null> = [];
    client.on('gateway:health', (h) => snapshots.push(h.activeCall));
    await new Promise<void>((r) => client.on('connect', () => r()));
    await new Promise((r) => setTimeout(r, 100)); // the snapshot is now waiting on the slow modem

    modem.emit('urc', ring()); // a call rings in while the snapshot waits
    expect(server.callManager.getCurrentCall()?.state).toBe('INBOUND_RINGING');
    release();
    await vi.waitFor(() => expect(snapshots.length).toBeGreaterThan(0));

    expect(snapshots[0]?.state).toBe('INBOUND_RINGING');
    client.disconnect();
    vi.restoreAllMocks();
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
