import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { createModemsRouter } from '../../src/api/routes/modems.js';
import { errorHandler } from '../../src/api/middleware/error-handler.js';
import { CallSessionManager } from '../../src/core/call-session-manager.js';
import { GatewayEventBus } from '../../src/core/event-bus.js';
import { ModemRegistry } from '../../src/modems/registry.js';
import { createModemUnit } from '../../src/modems/unit.js';
import { createGatewayServer } from '../../src/server.js';

function build(id: string, at: string, audioPort: string) {
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 100 });
  const audio = new MockAudioAdapter();
  const eventBus = new GatewayEventBus();
  eventBus.on('error', () => {});
  const callManager = new CallSessionManager({ modem, audio, eventBus });
  return createModemUnit({ descriptor: { modemId: id, name: id, model: 'MOCK', atPort: at, audio: { kind: 'usb-pcm', port: audioPort } }, modem, audio, callManager });
}

async function harness() {
  const registry = new ModemRegistry();
  const a = build('modem-a', 'COM14', 'COM13');
  const b = build('modem-b', 'COM27', 'ANALOG');
  registry.register(a);
  registry.register(b);
  await a.modem.initialize();
  await b.modem.initialize();
  const app = express();
  app.use(express.json());
  app.use('/api/modems', createModemsRouter({ registry }));
  app.use(errorHandler);
  const ring = (u: typeof a, n: string) => (u.modem as MockModemAdapter).simulateInboundCall(n);
  const wait = () => new Promise((r) => setTimeout(r, 25));
  return { app, registry, a, b, ring, wait };
}

// Mock-adapter tests: they prove that each request reaches only the modem named in its path.
describe('/api/modems', () => {
  it('lists both modems with independent status', async () => {
    const { app } = await harness();
    const res = await request(app).get('/api/modems').expect(200);
    expect(res.body.modems.map((m: { modemId: string }) => m.modemId)).toEqual(['modem-a', 'modem-b']);
    expect(res.body.defaultModemId).toBe('modem-a');
  });

  it('answers modem B without touching modem A, and hangs each up independently', async () => {
    const { app, registry, a, b, ring, wait } = await harness();
    ring(a, '+911111111111');
    ring(b, '+922222222222');
    await wait();
    const callA = registry.getCall('modem-a')!;
    const callB = registry.getCall('modem-b')!;

    const answered = await request(app).post('/api/modems/modem-b/answer').send({ callId: callB.id }).expect(200);
    expect(answered.body).toMatchObject({ modemId: 'modem-b', callId: callB.id });
    expect(registry.getCall('modem-b')?.state).toBe('ACTIVE');
    expect(registry.getCall('modem-a')?.state).toBe('INBOUND_RINGING');

    await request(app).post('/api/modems/modem-a/reject').send({ callId: callA.id }).expect(200);
    expect(registry.getCall('modem-a')).toBeNull();
    expect(registry.getCall('modem-b')?.state).toBe('ACTIVE');

    await request(app).post('/api/modems/modem-b/hangup').send({}).expect(200);
    expect(registry.getCall('modem-b')).toBeNull();
  });

  it('refuses a callId that belongs to the other modem or to an earlier call', async () => {
    const { app, registry, a, b, ring, wait } = await harness();
    ring(a, '+911111111111');
    ring(b, '+922222222222');
    await wait();
    const callA = registry.getCall('modem-a')!;
    const res = await request(app).post('/api/modems/modem-b/answer').send({ callId: callA.id }).expect(409);
    expect(res.body.error).toContain('modem-b');
    expect(registry.getCall('modem-b')?.state).toBe('INBOUND_RINGING');
    await request(app).post('/api/modems/modem-a/reject').send({ callId: 'stale' }).expect(409);
    expect(registry.getCall('modem-a')?.state).toBe('INBOUND_RINGING');
  });

  it('reject needs a ringing call; unknown modem is 404; dial and AI toggle are per modem', async () => {
    const { app, registry } = await harness();
    await request(app).post('/api/modems/modem-a/reject').send({}).expect(409);
    await request(app).post('/api/modems/modem-x/answer').send({}).expect(404);
    await request(app).put('/api/modems/modem-b/ai').send({ enabled: false }).expect(200);
    expect(registry.status('modem-a').aiEnabled).toBe(true);
    expect(registry.status('modem-b').aiEnabled).toBe(false);
    const dialed = await request(app).post('/api/modems/modem-a/dial').send({ phoneNumber: '+919876543210' }).expect(201);
    expect(dialed.body.modemId).toBe('modem-a');
    expect(registry.getCall('modem-a')).not.toBeNull();
    expect(registry.getCall('modem-b')).toBeNull();
  });

  it('refresh reports SIM, signal and network for the named modem', async () => {
    const { app } = await harness();
    const res = await request(app).post('/api/modems/modem-b/refresh').send({}).expect(200);
    expect(res.body.modemId).toBe('modem-b');
    expect(res.body.signal).not.toBeNull();
  });
});

describe('the server registers its existing modem as modem-a (legacy routes unchanged)', () => {
  it('exposes modem-a as the default and serves /api/modems with the api key', async () => {
    const dbPath = path.resolve('./data/test-modems-api.sqlite');
    const server = createGatewayServer({ config: { gatewayApiKey: 'k'.repeat(16), sqliteDbPath: dbPath }, modem: new MockModemAdapter() });
    try {
      expect(server.modemRegistry.defaultModemId).toBe('modem-a');
      expect(server.modemRegistry.get('modem-a').callManager).toBe(server.callManager);
      expect(server.modemRegistry.get('modem-a').modem).toBe(server.modem);
      await request(server.app).get('/api/modems').expect(401);
      const res = await request(server.app).get('/api/modems').set('x-api-key', 'k'.repeat(16)).expect(200);
      expect(res.body.modems).toHaveLength(1);
    } finally {
      await server.close().catch(() => {});
      for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });
});
