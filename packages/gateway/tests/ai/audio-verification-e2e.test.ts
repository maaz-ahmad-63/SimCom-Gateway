import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { CollectingAudioSink, ManualAudioSource } from '../../src/ai/audio.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { createGatewayServer, GatewayServerInstance } from '../../src/server.js';
import { aiEnv, FORMAT_8K, noiseFloorPcm, sleep, speechPcm } from './helpers.js';

/**
 * Call-audio verification inside a real gateway (mock modem and audio, scripted providers). Because everything here is simulated,
 * the honest result is Unable to verify on all three questions: these tests check the wiring (events, API, socket, storage, the
 * setting) and that calling itself still works, never that a simulated call can look verified.
 */
const API_KEY = 'audio-verification-e2e-key';

describe('call-audio verification in the gateway', () => {
  const cleanup: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
    vi.restoreAllMocks();
  });

  async function harness(env: Record<string, string | undefined> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-verif-'));
    const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
    const audio = new MockAudioAdapter();
    const source = new ManualAudioSource(FORMAT_8K, true);
    const sink = new CollectingAudioSink(FORMAT_8K, true);
    const providers = createMockProviders({ stt: ['what time do you open tomorrow'], llm: ['We open at nine in the morning.'] });
    const server: GatewayServerInstance = createGatewayServer({
      config: { modemDriver: 'mock', gatewayApiKey: API_KEY, sqliteDbPath: path.join(dir, 'gateway.sqlite'), enableUsbAudioDiagnostic: true },
      modem,
      audio,
      instanceLockDir: dir,
      ai: { env: aiEnv(env), providers, allowSimulatedHardware: true, mode: 'active', transports: () => ({ source, sink }) },
    });
    await modem.initialize();
    server.aiOrchestrator?.start();
    server.aiRuntime.audioVerification.start();
    const pushed: unknown[] = [];
    const io = (server.socketServer as unknown as { io: { emit: (e: string, p: unknown) => boolean } }).io;
    const realEmit = io.emit.bind(io);
    io.emit = (e: string, p: unknown) => {
      if (e === 'ai:audio-verification') pushed.push(p);
      return realEmit(e, p);
    };
    cleanup.push(async () => {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const api = (method: 'get' | 'post' | 'put', url: string) => request(server.app)[method](url).set('x-api-key', API_KEY);
    const startCall = async () => {
      const call = await server.callManager.dial({ phoneNumber: '+919876543210' });
      modem.emit('urc', { raw: 'VOICE CALL: BEGIN', type: 'VOICE_CALL_BEGIN', timestamp: new Date().toISOString(), isSimulated: false });
      await server.callManager.activateUsbAudioDiagnostic!();
      await sleep(60);
      return call;
    };
    const endCall = () => modem.emit('urc', { raw: 'VOICE CALL: END: 5', type: 'VOICE_CALL_END', durationSeconds: 5, timestamp: new Date().toISOString(), isSimulated: false });
    const callerSpeaks = () => {
      source.push(speechPcm(1200));
      source.push(noiseFloorPcm(1200));
    };
    return { server, modem, sink, providers, api, startCall, endCall, callerSpeaks, pushed };
  }

  it('the API needs the gateway key, and verification is on by default', async () => {
    const h = await harness();
    expect((await request(h.server.app).get('/api/ai/audio-verification')).status).toBe(401);
    const r = await h.api('get', '/api/ai/audio-verification');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, current: null, recent: [] });
  });

  it('follows a real call through the gateway, saves and pushes it, and never shows a simulated call as verified', async () => {
    const h = await harness();
    const call = await h.startCall();
    expect((await h.api('post', `/api/ai/calls/${call.id}/arm`)).status).toBe(200);
    h.callerSpeaks();
    await vi.waitFor(() => expect(h.providers.stt.calls.length).toBeGreaterThan(0), { timeout: 4000 });
    await vi.waitFor(() => expect(h.sink.playCalls).toBeGreaterThan(0), { timeout: 4000 }); // calling and replying still work
    const live = (await h.api('get', '/api/ai/audio-verification')).body.current;
    expect(live.callId).toBe(call.id);
    h.endCall();
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 4000 });
    const done = (await h.api('get', `/api/ai/audio-verification/${call.id}`)).body;
    expect(done).toMatchObject({ callId: call.id, final: true, simulated: true });
    for (const a of [done.inbound, done.transport, done.audibility]) {
      expect(a.status).toBe('unable');
      expect(a.reason).toMatch(/simulated/);
    }
    expect(h.pushed.length).toBeGreaterThan(0);
    expect((h.pushed.at(-1) as { final: boolean }).final).toBe(true);
    expect(JSON.stringify(done)).not.toContain('what time do you open'); // no transcript text is stored
    const list = (await h.api('get', '/api/ai/audio-verification')).body.recent;
    expect(list[0]).toMatchObject({ callId: call.id, inbound: 'unable', transport: 'unable', audibility: 'unable', final: true });
  });

  it('the diagnostic key-press test is validated and only armed on a call in progress', async () => {
    const h = await harness();
    expect((await h.api('post', '/api/ai/audio-verification/nope/key-test').send({ key: '1' })).status).toBe(409);
    const call = await h.startCall();
    expect((await h.api('post', `/api/ai/audio-verification/${call.id}/key-test`).send({ key: 'x' })).status).toBe(400);
    expect((await h.api('post', `/api/ai/audio-verification/${call.id}/key-test`).send({ key: '1', windowMs: 10 })).status).toBe(400);
    const ok = await h.api('post', `/api/ai/audio-verification/${call.id}/key-test`).send({ key: '1' });
    expect(ok.status).toBe(200);
    expect(ok.body.audibility.evidence.some((e: { detail: string }) => /key-press test armed/.test(e.detail))).toBe(true);
    expect((await h.api('get', '/api/ai/audio-verification/unknown-call')).status).toBe(404);
  });

  it('the dashboard switch turns it off for new calls and back on, through the normal settings endpoint', async () => {
    const h = await harness();
    const off = await h.api('put', '/api/ai/settings').send({ audioAutoVerify: false });
    expect(off.status).toBe(200);
    expect((await h.api('get', '/api/ai/audio-verification')).body.enabled).toBe(false);
    const call = await h.startCall();
    h.endCall();
    await vi.waitFor(() => expect(h.server.callManager.getCurrentCall()).toBeNull(), { timeout: 4000 });
    expect((await h.api('get', `/api/ai/audio-verification/${call.id}`)).status).toBe(404);
    expect((await h.api('put', '/api/ai/settings').send({ audioAutoVerify: true })).status).toBe(200);
    expect((await h.api('get', '/api/ai/audio-verification')).body.enabled).toBe(true);
  });
});
