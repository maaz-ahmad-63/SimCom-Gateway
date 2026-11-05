import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockAudioAdapter } from '../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../src/adapters/modem/mock-modem.js';
import { createGatewayServer, GatewayServerInstance } from '../src/server.js';
import { provisionMasterKey } from '../src/supervisor/master-key.js';
import { aiEnv } from './ai/helpers.js';

/**
 * The customer workflow for provider API keys, through the real gateway API (mock modem, temporary database): the master key comes from
 * the supervisor's provisioning, a key added in the dashboard is encrypted and survives a restart, nothing returns or logs the plaintext,
 * and a replaced master key shows up as unreadable keys instead of silently losing them. No real modem, provider or network is involved.
 */
const GATEWAY_KEY = 'test-gateway-api-key-0123456789';
const CUSTOMER_KEY = 'dg-customer-secret-ABCDEFGHIJKLMN';
const REPLACEMENT_KEY = 'dg-second-secret-OPQRSTUVWXYZ12';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
  vi.restoreAllMocks();
});

function boot(dir: string, masterKey: string | undefined) {
  const modem = new MockModemAdapter({ autoAnswerDelayMs: 0 });
  const server: GatewayServerInstance = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: GATEWAY_KEY, sqliteDbPath: path.join(dir, 'gateway.sqlite'), audioDumpDir: path.join(dir, 'recordings') },
    modem,
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: { env: aiEnv({ AI_SECRETS_MASTER_KEY: masterKey, DEEPGRAM_API_KEY: undefined }), allowSimulatedHardware: true },
  });
  const api = (method: 'get' | 'put' | 'delete', url: string) => request(server.app)[method](url).set('x-api-key', GATEWAY_KEY);
  return { server, api, stop: () => server.close() };
}

describe('adding, updating and removing a provider key from the dashboard', () => {
  it('works with the provisioned master key, survives restarts, and never returns or logs the key', async () => {
    const logs: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' ')));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keywf-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const secretsDir = path.join(dir, 'secrets');
    const provision = () => provisionMasterKey({ secretsDir, env: {}, fileValues: {}, dbPath: path.join(dir, 'gateway.sqlite') }, { protect: () => ({ ok: true }) });

    // first run: the supervisor makes the key; the gateway is started with it
    const first = provision();
    expect(first.state).toBe('created');
    const a = boot(dir, first.key!);
    expect((await a.api('get', '/api/ai/settings')).body.secretStorageAvailable).toBe(true);
    const before = (await a.api('get', '/api/ai/credentials')).body.credentials.find((c: { name: string }) => c.name === 'DEEPGRAM_API_KEY');
    expect(before.source).toBe('missing'); // "Not configured"

    // add
    const saved = await a.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: CUSTOMER_KEY });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(CUSTOMER_KEY);
    const listed = await a.api('get', '/api/ai/credentials');
    expect(listed.body.credentials.find((c: { name: string }) => c.name === 'DEEPGRAM_API_KEY').source).toBe('stored'); // "Configured"
    expect(JSON.stringify(listed.body)).not.toContain(CUSTOMER_KEY);
    for (const path of ['/api/ai/state', '/api/ai/settings']) expect(JSON.stringify((await a.api('get', path)).body)).not.toContain(CUSTOMER_KEY);
    await a.stop();

    // restart, then an upgrade: the same key file gives the same key, so the saved key is still there
    for (let restart = 0; restart < 2; restart++) {
      const again = provision();
      expect(again).toMatchObject({ state: 'ok', key: first.key });
      const b = boot(dir, again.key!);
      expect((await b.api('get', '/api/ai/credentials')).body.credentials.find((c: { name: string }) => c.name === 'DEEPGRAM_API_KEY')).toMatchObject({ source: 'stored' });
      if (restart === 0) {
        // update
        expect((await b.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: REPLACEMENT_KEY })).status).toBe(200);
      } else {
        // remove
        expect((await b.api('delete', '/api/ai/credentials/DEEPGRAM_API_KEY')).status).toBe(200);
        expect((await b.api('get', '/api/ai/credentials')).body.credentials.find((c: { name: string }) => c.name === 'DEEPGRAM_API_KEY').source).toBe('missing');
      }
      await b.stop();
    }

    expect(logs.join('\n')).not.toContain(CUSTOMER_KEY);
    expect(logs.join('\n')).not.toContain(REPLACEMENT_KEY);
    expect(logs.join('\n')).not.toContain(first.key!);
    // and on disk the saved key was only ever stored encrypted
    const rawDb = fs.readFileSync(path.join(dir, 'gateway.sqlite'));
    expect(rawDb.includes(Buffer.from(CUSTOMER_KEY))).toBe(false);
    expect(rawDb.includes(Buffer.from(REPLACEMENT_KEY))).toBe(false);
  }, 60_000);

  it('shows keys saved under a key that is no longer in use as unreadable, and lets the customer enter them again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keywf-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const original = 'a'.repeat(64);
    const a = boot(dir, original);
    await a.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: CUSTOMER_KEY });
    await a.stop();

    const wrong = boot(dir, 'b'.repeat(64)); // what a silently regenerated key would have done
    const status = (await wrong.api('get', '/api/ai/credentials')).body.credentials.find((c: { name: string }) => c.name === 'DEEPGRAM_API_KEY');
    expect(status.source).toBe('missing');
    expect(status.lastCheckDetail).toMatch(/cannot be decrypted/);
    expect((await wrong.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: REPLACEMENT_KEY })).status).toBe(200); // entering it again works
    expect((await wrong.api('get', '/api/ai/credentials')).body.credentials.find((c: { name: string }) => c.name === 'DEEPGRAM_API_KEY').source).toBe('stored');
    await wrong.stop();
  }, 60_000);

  it('runs without key storage when no master key was given (the supervisor found a problem), and saving a key is refused, not lost', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keywf-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const g = boot(dir, '');
    expect((await g.api('get', '/api/ai/settings')).body.secretStorageAvailable).toBe(false);
    expect((await g.api('put', '/api/ai/credentials/DEEPGRAM_API_KEY').send({ value: CUSTOMER_KEY })).status).toBe(409);
    await g.stop();
  }, 60_000);
});
