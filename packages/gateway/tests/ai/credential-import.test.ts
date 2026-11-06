import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioAdapter } from '../../src/adapters/audio/mock-audio.js';
import { MockModemAdapter } from '../../src/adapters/modem/mock-modem.js';
import { apiKeyProblem, parseEnvText } from '../../src/ai/env-import.js';
import { createMockProviders } from '../../src/ai/providers/mock.js';
import { resetActiveRegistry } from '../../src/ai/registry/active.js';
import { createGatewayServer } from '../../src/server.js';
import { aiEnv } from './helpers.js';

describe('parsing pasted .env text', () => {
  it('reads plain, exported, quoted and =-containing values, skips comments and blank lines, and keeps the last duplicate', () => {
    const r = parseEnvText(
      [
        '﻿# a comment',
        '',
        'GROQ_API_KEY=gsk_plainvalue123',
        'export OPENAI_API_KEY="sk-quoted \\"inner\\" value"',
        "DEEPGRAM_API_KEY='single=quoted=value'",
        'CARTESIA_API_KEY=abc=def==  # trailing comment',
        'INWORLD_API_KEY=first-value-1234',
        'INWORLD_API_KEY=second-value-5678',
        '   SONIOX_API_KEY = spaced-value-999   ',
        'not a line',
        '1BAD=x',
        'MURF_API_KEY="unterminated',
        'ELEVENLABS_API_KEY="ok-value-123" junk',
      ].join('\r\n')
    );
    const v = Object.fromEntries(r.entries.map((e) => [e.name, e.value]));
    expect(v).toEqual({
      GROQ_API_KEY: 'gsk_plainvalue123',
      OPENAI_API_KEY: 'sk-quoted "inner" value',
      DEEPGRAM_API_KEY: 'single=quoted=value',
      CARTESIA_API_KEY: 'abc=def==',
      INWORLD_API_KEY: 'second-value-5678',
      SONIOX_API_KEY: 'spaced-value-999',
    });
    expect(r.duplicates).toEqual(['INWORLD_API_KEY']);
    expect(r.problems.map((p) => [p.line, p.name, p.reason])).toEqual([
      [10, null, 'not a NAME=value line'],
      [11, null, 'the name is not a valid variable name'],
      [12, 'MURF_API_KEY', 'the quoted value has no closing quote'],
      [13, 'ELEVENLABS_API_KEY', 'unexpected text after the closing quote'],
    ]);
  });

  it('refuses empty, short, spaced and placeholder values', () => {
    expect(apiKeyProblem('')).toMatch(/empty/);
    expect(apiKeyProblem('short')).toMatch(/8-512/);
    expect(apiKeyProblem('has a space in it')).toMatch(/no spaces/);
    expect(apiKeyProblem('your_api_key_here')).toMatch(/placeholder/);
    expect(apiKeyProblem('<paste-key>')).toMatch(/placeholder/);
    expect(apiKeyProblem('xxxxxxxxxxxx')).toMatch(/placeholder/);
    expect(apiKeyProblem('gsk_realLookingKey123')).toBeNull();
  });
});

const API_KEY = 'credential-import-test-key';
const closers: Array<() => Promise<void>> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  resetActiveRegistry();
});

async function boot(env: Record<string, string | undefined> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-import-'));
  dirs.push(dir);
  const baseEnv = aiEnv({ AI_SECRETS_MASTER_KEY: 'a-long-master-key-for-tests-only', GROQ_API_KEY: undefined, OPENAI_API_KEY: undefined, ...env });
  const frozen = JSON.stringify(baseEnv);
  const server = createGatewayServer({
    config: { modemDriver: 'mock', gatewayApiKey: API_KEY, sqliteDbPath: path.join(dir, 'g.sqlite'), audioDumpDir: path.join(dir, 'rec') },
    modem: new MockModemAdapter({ autoAnswerDelayMs: 0 }),
    audio: new MockAudioAdapter(),
    instanceLockDir: dir,
    ai: { env: baseEnv, providers: createMockProviders({ stt: ['x'], llm: ['y'] }), allowSimulatedHardware: true, registryDir: path.join(dir, 'registry') },
  });
  closers.push(async () => void (await server.close()));
  const post = (url: string, body: object) => request(server.app).post(url).set('x-api-key', API_KEY).send(body);
  const get = (url: string) => request(server.app).get(url).set('x-api-key', API_KEY);
  return { server, post, get, envUnchanged: () => JSON.stringify(baseEnv) === frozen };
}

const GROQ = 'gsk_groqImportedKey_000111';
const OPENAI = 'sk-openaiImportedKey-222333';
const INWORLD = 'aW53b3JsZEltcG9ydGVkS2V5PT0=';
const PASTE = [
  '# my .env',
  `GROQ_API_KEY=${GROQ}`,
  `OPENAI_API_KEY="${OPENAI}"`,
  `INWORLD_API_KEY='${INWORLD}'`,
  'SQLITE_DB_PATH=./data/gateway.sqlite',
  'MODEM_AT_PORT=COM20',
  'DEEPGRAM_API_KEY=your_api_key_here',
].join('\n');
const secretsIn = (body: unknown) => [GROQ, OPENAI, INWORLD].filter((s) => JSON.stringify(body).includes(s));

describe('POST /api/ai/credentials/import', () => {
  it('preview stores nothing and reports recognised (masked), invalid and unrelated entries', async () => {
    const h = await boot();
    const res = await h.post('/api/ai/credentials/import/preview', { text: PASTE });
    expect(res.status).toBe(200);
    expect(res.body.recognized.map((r: any) => [r.name, r.provider, r.action, r.masked])).toEqual([
      ['GROQ_API_KEY', 'Groq', 'add', `••••${GROQ.slice(-4)}`],
      ['OPENAI_API_KEY', 'OpenAI', 'add', `••••${OPENAI.slice(-4)}`],
      ['INWORLD_API_KEY', 'Inworld', 'add', `••••${INWORLD.slice(-4)}`],
    ]);
    expect(res.body.invalid).toEqual([{ line: 7, name: 'DEEPGRAM_API_KEY', reason: 'looks like a placeholder, not a real key' }]);
    expect(res.body.unrecognized.map((u: any) => u.name)).toEqual(['SQLITE_DB_PATH', 'MODEM_AT_PORT']);
    expect(res.body).not.toHaveProperty('values');
    expect(secretsIn(res.body)).toEqual([]);
    const creds = (await h.get('/api/ai/credentials')).body.credentials;
    expect(creds.find((c: any) => c.name === 'GROQ_API_KEY').source).toBe('missing');
  });

  it('apply stores every recognised key encrypted, reloads the configuration live, and never returns a full value', async () => {
    const h = await boot();
    const res = await h.post('/api/ai/credentials/import/apply', { text: PASTE });
    expect(res.status).toBe(200);
    expect(res.body.added.map((a: any) => a.name)).toEqual(['GROQ_API_KEY', 'OPENAI_API_KEY', 'INWORLD_API_KEY']);
    expect(res.body.updated).toEqual([]);
    expect(secretsIn(res.body)).toEqual([]);
    const creds = res.body.credentials as any[];
    for (const name of ['GROQ_API_KEY', 'OPENAI_API_KEY', 'INWORLD_API_KEY']) expect(creds.find((c) => c.name === name)).toMatchObject({ source: 'stored' });
    expect(creds.find((c) => c.name === 'DEEPGRAM_API_KEY').source).not.toBe('stored'); // the placeholder was not stored
    // the gateway uses them now (server side only)
    expect(h.server.aiRuntime['options'].settings.resolveSecret('GROQ_API_KEY')).toBe(GROQ);
    // stored encrypted, not as plain text in the database
    const raw = (h.server as any).db.prepare("SELECT value FROM gateway_settings WHERE key = 'ai.secret.GROQ_API_KEY'").get();
    expect(raw).toBeDefined();
    expect(String(raw.value)).not.toContain(GROQ);
    // nothing anywhere in the API shows the value
    for (const url of ['/api/ai/credentials', '/api/ai/settings', '/api/ai/state']) expect(secretsIn((await h.get(url)).body), url).toEqual([]);
    expect(h.envUnchanged()).toBe(true); // .env values are not modified
  });

  it('a second import reports unchanged and updated keys, leaves keys not in the text alone, and can be limited to chosen names', async () => {
    const h = await boot();
    await h.post('/api/ai/credentials/import/apply', { text: PASTE });
    const second = await h.post('/api/ai/credentials/import/preview', { text: `GROQ_API_KEY=${GROQ}\nOPENAI_API_KEY=sk-a-different-new-key-9999` });
    expect(second.body.recognized.map((r: any) => [r.name, r.action])).toEqual([
      ['GROQ_API_KEY', 'unchanged'],
      ['OPENAI_API_KEY', 'update'],
    ]);
    const only = await h.post('/api/ai/credentials/import/apply', { text: `GROQ_API_KEY=gsk_new_groq_value_77\nOPENAI_API_KEY=sk-a-different-new-key-9999`, only: ['OPENAI_API_KEY'] });
    expect(only.body.updated.map((u: any) => u.name)).toEqual(['OPENAI_API_KEY']);
    const settings = h.server.aiRuntime['options'].settings;
    expect(settings.resolveSecret('OPENAI_API_KEY')).toBe('sk-a-different-new-key-9999');
    expect(settings.resolveSecret('GROQ_API_KEY')).toBe(GROQ); // not chosen: untouched
    expect(settings.resolveSecret('INWORLD_API_KEY')).toBe(INWORLD); // not in the text: untouched
    const bad = await h.post('/api/ai/credentials/import/apply', { text: `GROQ_API_KEY=${GROQ}`, only: ['MODEM_AT_PORT'] });
    expect(bad.status).toBe(400);
  });

  it('a key that is only in .env is reported as one the import will take priority over', async () => {
    const h = await boot({ GROQ_API_KEY: 'gsk_from_the_env_file_123' });
    const res = await h.post('/api/ai/credentials/import/preview', { text: `GROQ_API_KEY=${GROQ}` });
    expect(res.body.recognized[0]).toMatchObject({ action: 'add', overridesEnv: true });
  });

  it('without key storage nothing is imported, and the reason is given', async () => {
    const h = await boot({ AI_SECRETS_MASTER_KEY: undefined });
    const res = await h.post('/api/ai/credentials/import/apply', { text: PASTE });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Key storage is not enabled/);
    expect(secretsIn(res.body)).toEqual([]);
    expect((await h.get('/api/ai/credentials')).body.credentials.find((c: any) => c.name === 'GROQ_API_KEY').source).toBe('missing');
  });

  it('a provider added in the Model Hub is recognised by its own credential name', async () => {
    const h = await boot();
    const created = await h.post('/api/ai/registry/providers', { id: 'acme', name: 'Acme AI', credential: 'ACME_API_KEY', baseUrl: 'https://api.acme.example/v1' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const res = await h.post('/api/ai/credentials/import/preview', { text: 'ACME_API_KEY=acme-secret-key-123456' });
    expect(res.body.recognized.map((r: any) => [r.name, r.provider])).toEqual([['ACME_API_KEY', 'Acme AI']]);
  });

  it('refuses something that is not text', async () => {
    const h = await boot();
    expect((await h.post('/api/ai/credentials/import/preview', { text: 42 })).status).toBe(400);
  });
});
