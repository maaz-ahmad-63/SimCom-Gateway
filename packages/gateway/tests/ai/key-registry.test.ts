import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv, fakeFetch, json } from './helpers.js';

/**
 * The API Keys page shows exactly what GET /api/ai/credentials returns, and that list is built from one registry
 * (CREDENTIAL_PROVIDERS). A provider missing from the page was a provider missing from that registry.
 */
const KEY = 'key-registry-test-key-123456';
const SIX = ['MURF_API_KEY', 'TELNYX_API_KEY', 'DEEPGRAM_API_KEY', 'INWORLD_API_KEY', 'CARTESIA_API_KEY', 'SONIOX_API_KEY'];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function gateway(fetchImpl?: ReturnType<typeof fakeFetch>['impl']) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-'));
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  await modem.initialize();
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', DEEPGRAM_API_KEY: undefined, TELNYX_API_KEY: undefined, CARTESIA_API_KEY: undefined }), providers: createMockProviders(), allowSimulatedHardware: true, fetchImpl },
  });
  cleanups.push(async () => {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const api = (m: 'get' | 'put' | 'post' | 'delete', url: string) => request(server.app)[m](url).set('x-api-key', KEY);
  return { api };
}

describe('the provider key list the API Keys page renders', () => {
  it('lists all six requested providers exactly once, each as an entry that can be added', async () => {
    const { api } = await gateway();
    const res = await api('get', '/api/ai/credentials');
    expect(res.body.secretStorageAvailable).toBe(true);
    const names: string[] = res.body.credentials.map((c: { name: string }) => c.name);
    for (const name of SIX) expect(names.filter((n) => n === name), name).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length); // no duplicates anywhere
    for (const name of ['MURF_API_KEY', 'INWORLD_API_KEY', 'SONIOX_API_KEY']) {
      expect(res.body.credentials.find((c: { name: string }) => c.name === name)).toMatchObject({ source: 'missing', masked: null });
    }
  });

  it('adds, tests, replaces and removes Murf, Soniox and Inworld keys, never returning the key, and leaves the other keys alone', async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const { impl } = fakeFetch([(req) => { seen.push({ url: req.url, headers: req.headers }); return json({ voices: [] }); }]);
    const { api } = await gateway(impl);
    const existing = 'dg-existing-ABCDEFGH1234567890';
    expect((await api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: existing })).status).toBe(200);
    const before = (await api('get', '/api/ai/credentials')).body.credentials.find((c: any) => c.name === 'DEEPGRAM_API_KEY');

    const secrets: Record<string, string> = { MURF_API_KEY: 'murf-ZYXWVUTS9876543210abc', SONIOX_API_KEY: 'soniox-ZYXWVUTS9876543210ab', INWORLD_API_KEY: 'aW53b3JsZC1iYXNlNjQta2V5LXRlc3Q9' };
    for (const [name, value] of Object.entries(secrets)) {
      const put = await api('put', `/api/ai/credentials/${name}`).send({ value });
      expect(put.status, name).toBe(200);
      expect(JSON.stringify(put.body), name).not.toContain(value);
      expect(put.body.credentials.find((c: any) => c.name === name)).toMatchObject({ source: 'stored' });

      const check = await api('post', `/api/ai/credentials/${name}/validate`);
      expect(check.status, name).toBe(200);
      expect(check.body.check, name).toBe('ok');
      expect(JSON.stringify(check.body), name).not.toContain(value);
    }
    // Each test went to that provider's own read-only endpoint with its own header scheme.
    expect(seen.map((s) => new URL(s.url).host)).toEqual(['global.api.murf.ai', 'api.soniox.com', 'api.inworld.ai']);
    expect(seen[0].headers['api-key']).toBe(secrets.MURF_API_KEY);
    expect(seen[1].headers.authorization).toBe(`Bearer ${secrets.SONIOX_API_KEY}`);
    expect(seen[2].headers.authorization).toBe(`Basic ${secrets.INWORLD_API_KEY}`);

    // Replace, then remove: only that entry changes.
    const replaced = await api('put', '/api/ai/credentials/MURF_API_KEY').send({ value: 'murf-REPLACED9876543210xyz' });
    expect(replaced.body.credentials.find((c: any) => c.name === 'MURF_API_KEY').masked).not.toBe(before.masked);
    const removed = await api('delete', '/api/ai/credentials/SONIOX_API_KEY');
    expect(removed.body.credentials.find((c: any) => c.name === 'SONIOX_API_KEY')).toMatchObject({ source: 'missing' });
    const after = removed.body.credentials;
    expect(after.find((c: any) => c.name === 'DEEPGRAM_API_KEY')).toMatchObject({ source: 'stored', masked: before.masked }); // the existing credential was never touched
    expect(after.find((c: any) => c.name === 'INWORLD_API_KEY')).toMatchObject({ source: 'stored' });
    expect(after.filter((c: any) => c.name === 'MURF_API_KEY')).toHaveLength(1);
  });

  it('reports a rejected key for the new providers by name, and refuses names that are not registered', async () => {
    const { impl } = fakeFetch([json({ error: 'nope' }, 401)]);
    const { api } = await gateway(impl);
    await api('put', '/api/ai/credentials/INWORLD_API_KEY').send({ value: 'aW53b3JsZC1iYXNlNjQta2V5LXRlc3Q9' });
    const check = await api('post', '/api/ai/credentials/INWORLD_API_KEY/validate');
    expect(check.body).toMatchObject({ check: 'invalid' });
    expect(check.body.detail).toMatch(/Inworld rejected the key \(HTTP 401\)/);
    expect((await api('put', '/api/ai/credentials/NOT_A_PROVIDER_KEY').send({ value: 'x'.repeat(20) })).status).toBe(404);
  });
});
