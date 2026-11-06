import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { COMBINED_FILE } from '../src/recording/call-recorder.js';
import { RecordingConfig } from '../src/recording/config.js';
import { effectiveRecordingConfig } from '../src/recording/recording-settings.js';
import { createGatewayServer, GatewayServerInstance } from '../src/server.js';

/**
 * Settings > Call Recording through the real gateway call flow (mock modem and mock audio): consent before recording, live changes
 * without a restart, the per-call reason when a call is not recorded, and settings that survive a restart. Mock audio only: this does not
 * prove a recording of a real call (that needs the modem).
 */
const KEY = 'recording-settings-test-key';
const OFF: RecordingConfig = { enabled: false, consentAcknowledged: false, dir: '', retentionDays: 0, maxSeconds: 600, errors: [] };
const dirs: string[] = [];
const servers: GatewayServerInstance[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function boot(dir: string, recording: Partial<RecordingConfig> = {}) {
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0, ringIntervalMs: 100 });
  const audio = new MockAudioAdapter({ frameDurationMs: 20 });
  const server = createGatewayServer({
    config: { port: 41000 + Math.floor(Math.random() * 8000), host: '127.0.0.1', modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'dumps') },
    modem,
    audio,
    instanceLockDir: dir,
    recording: { ...OFF, dir: path.join(dir, 'recs'), ...recording },
  });
  servers.push(server);
  await server.start();
  await modem.initialize();
  const api = (method: 'get' | 'put', url: string) => request(server.app)[method](url).set('x-api-key', KEY);
  /** One answered inbound call; returns its id once it is ACTIVE (the mock audio produces caller frames meanwhile). */
  const call = async (ms = 300) => {
    modem.emit('urc', { raw: '+CRING: VOICE', type: 'RING', timestamp: new Date().toISOString(), isSimulated: false });
    modem.emit('urc', { raw: '+CLIP: "+10000000000",145', type: 'CLIP', phoneNumber: '+10000000000', typeOfAddress: 145, timestamp: new Date().toISOString(), isSimulated: false });
    await server.callManager.answer();
    const id = server.callManager.getCurrentCall()!.id;
    await new Promise((r) => setTimeout(r, ms));
    return id;
  };
  const hangup = async () => {
    await server.callManager.hangup();
    await server.callRecorder.whenIdle();
  };
  return { server, api, call, hangup };
}
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-settings-'));
  dirs.push(d);
  return d;
};

describe('Settings > Call Recording', () => {
  it('starts from the environment values, refuses to switch on without consent, and records from the next call once switched on (no restart)', async () => {
    const h = await boot(tmp());
    const first = await h.api('get', '/api/gateway/recordings/settings');
    expect(first.body).toMatchObject({ source: 'environment', settings: { enabled: false, consentAcknowledged: false }, status: { inactiveReason: expect.stringMatching(/switched off/) } });

    const refused = await h.api('put', '/api/gateway/recordings/settings').send({ enabled: true });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/consent acknowledgement/);

    // A call while it is off is not recorded, and the reason is kept for that call.
    const offCall = await h.call();
    await h.hangup();

    const on = await h.api('put', '/api/gateway/recordings/settings').send({ enabled: true, consentAcknowledged: true, retentionDays: 30 });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ source: 'saved', settings: { enabled: true, consentAcknowledged: true, retentionDays: 30 }, status: { inactiveReason: null } });
    expect(on.body.settings.consentAcknowledgedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    const recorded = await h.call();
    await h.hangup();
    const list = await h.api('get', `/api/gateway/recordings?ids=${offCall},${recorded}`);
    expect(list.body.recordings.map((r: any) => [r.callId, r.complete, r.available, r.file])).toEqual([[recorded, true, true, COMBINED_FILE]]);
    expect(list.body.notRecorded).toEqual([{ callId: offCall, status: 'off', reason: expect.stringMatching(/switched off/), at: expect.any(String) }]);
    const wav = await h.api('get', `/api/gateway/recordings/${recorded}/audio.wav`);
    expect(wav.status).toBe(200);
  });

  it('withdrawing consent switches recording off; switching off mid-call keeps what was captured, marked incomplete', async () => {
    const h = await boot(tmp(), { enabled: true, consentAcknowledged: true });
    const id = await h.call(400);
    const off = await h.api('put', '/api/gateway/recordings/settings').send({ consentAcknowledged: false });
    expect(off.body.settings).toMatchObject({ enabled: false, consentAcknowledged: false, consentAcknowledgedAt: null });
    await h.hangup();
    const rec = (await h.api('get', `/api/gateway/recordings?ids=${id}`)).body.recordings[0];
    expect(rec).toMatchObject({ callId: id, complete: false, error: expect.stringMatching(/switched off during the call/) });
    expect(rec.durationMs).toBeGreaterThan(0); // the part before it was switched off is kept

    const next = await h.call();
    await h.hangup();
    expect((await h.api('get', `/api/gateway/recordings?ids=${next}`)).body.notRecorded[0]).toMatchObject({ callId: next, status: 'off' });
  });

  it('a call while switched on without consent (old environment values) is noted as such', async () => {
    const h = await boot(tmp(), { enabled: true, consentAcknowledged: false });
    const id = await h.call();
    await h.hangup();
    expect((await h.api('get', `/api/gateway/recordings?ids=${id}`)).body.notRecorded[0]).toMatchObject({ status: 'no-consent', reason: expect.stringMatching(/consent acknowledgement has not been confirmed/) });
  });

  it('a recording that cannot start (the folder cannot be written) is reported as a failure for that call, not as a recording', async () => {
    const dir = tmp();
    const blocker = path.join(dir, 'recs');
    fs.writeFileSync(blocker, 'a file where the recordings folder should be');
    const h = await boot(dir, { enabled: true, consentAcknowledged: true });
    const id = await h.call();
    await h.hangup();
    const body = (await h.api('get', `/api/gateway/recordings?ids=${id}`)).body;
    expect(body.recordings).toEqual([]);
    expect(body.notRecorded[0]).toMatchObject({ callId: id, status: 'start-failed', reason: expect.stringMatching(/Could not start recording/) });
    expect(body.status.lastError).toMatch(/Could not start recording/);
  });

  it('saved settings survive a restart and win over the environment values', async () => {
    const dir = tmp();
    const first = await boot(dir);
    await first.api('put', '/api/gateway/recordings/settings').send({ enabled: true, consentAcknowledged: true, maxSeconds: 120 });
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    const second = await boot(dir); // the environment still says off
    expect((await second.api('get', '/api/gateway/recordings/settings')).body).toMatchObject({ source: 'saved', settings: { enabled: true, consentAcknowledged: true, maxSeconds: 120 }, status: { inactiveReason: null } });
  });

  it('rejects values out of range and leaves the settings as they were', async () => {
    const h = await boot(tmp());
    for (const body of [{ enabled: 'yes' }, { retentionDays: -1 }, { maxSeconds: 5 }, { maxSeconds: 1.5 }]) {
      expect((await h.api('put', '/api/gateway/recordings/settings').send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await h.api('get', '/api/gateway/recordings/settings')).body.source).toBe('environment');
  });
});

describe('effective recording configuration', () => {
  it('saved values replace the environment ones, and their environment errors with them', () => {
    const base: RecordingConfig = { ...OFF, dir: 'x', errors: ['CALL_RECORDING_ENABLED must be true or false', 'CALL_RECORDING_DIR something'] };
    expect(effectiveRecordingConfig(base, null)).toBe(base);
    const c = effectiveRecordingConfig(base, { enabled: true, consentAcknowledged: true, consentAcknowledgedAt: 'now', retentionDays: 7, maxSeconds: 60, updatedAt: 'now' });
    expect(c).toMatchObject({ enabled: true, consentAcknowledged: true, retentionDays: 7, maxSeconds: 60, dir: 'x', errors: ['CALL_RECORDING_DIR something'] });
    expect(effectiveRecordingConfig(base, { enabled: true, consentAcknowledged: false, consentAcknowledgedAt: null, retentionDays: 0, maxSeconds: 60, updatedAt: 'now' }).enabled).toBe(false);
  });
});
